# Multi-Plant Architecture Assessment — Las Vegas Expansion

> Status: **recommendation approved (Option 2) 2026-07-10 · Phase 0 DELIVERED** — `PlantContext`
> (`backend/app/core/plant_context.py`), `user_plants` promoted (is_default/granted_by/created_at,
> unique, SJ+MIRA behavior-preserving backfill: 54 rows / 27 defaults), login + `/api/auth/me/plants`
> return memberships, invite → membership, plants CRUD admin-only + membership-scoped list,
> `X-Plant-Id` axios interceptor + header plant selector (i18n en/fr/es), tests
> `backend/tests/test_plant_context.py` (7 green).
> **Phase 1 DELIVERED (same day)** — `plant_id` added to 24 tables (models + startup ALTERs), boot-time
> self-healing backfills (machine→plant, equipment→plant), one-time cost-center site rule
> (`plant_cost_site_rule_2026_07_10`, encodes costs.py `_site_of()` into data), plant-scoped indexes.
> Result: 8,219 WOs (7,713 SJ / 506 MIRA), tickets/alerts/stops/production/SAP lines 100% assigned,
> 0 cross-plant mismatches. Remaining NULLs by design: 570 suppliers (pending decision), 14 orphan
> machines (4 active: IMA 04, KAL, SCHELLING 04, STEFANI), 3 machine_history rows that heal with them.
> Review file: `docs/plant-backfill-review.csv` (regenerate via `scripts/plant_backfill_report.sql`).
> Hypertables (sensor_readings, machine_production_hourly) intentionally have NO plant column
> (compressed chunks; derive via joins); technicians scope via user_plants, no column.
> **Open decisions ANSWERED (user, 2026-07-10):** orphan machines → SJ (all 14; 4 active confirmed by
> name); inventory = shared SJ+MIRA warehouse; suppliers = SJ+MIRA shared pool, LV builds its own;
> memberships stay SJ+MIRA for all 27 users (trim later in Settings → Users). Implemented via
> `plants.group_code = 'QC'` (group-scoped models: StockItem, Supplier; everything else plant-scoped).
> **Phase 2 WAVE 1 DELIVERED (same day)** — central helpers `core/plant_scope.py` (`plant_scoped`,
> `plant_condition`, `ensure_same_plant` → 404, `path_plant_guard` router dependency,
> `require_technician_in_plant`); scoped: machines (authed surface), alerts, tickets, work_orders
> (router-level path guard covers all ~20 member routes), maintenance_dashboard (all aggregates),
> technicians (via membership), equipment, inventory + suppliers (group pool), purchase orders
> (plant-scoped, stamped at creation); creation stamping in alert/ticket services (covers kiosk).
> Validated with a real MIRA-only persona (`test-mira-only@kaizo-test.com`): lists show only MIRA
> (506 WOs vs SJ 7,713), SJ ids → 404, forced `X-Plant-Id: SJ` → 403, plants list hides SJ.
> **Official plant codes (user, 2026-07-10): QS = Saint-Jérôme, QM = Mirabel, NL = Las Vegas.**
> DB codes renamed from PLT1/MIRA via one-time `plant_codes_qs_qm_2026_07_10` (joins are by UUID —
> rename is display/lookup only; earlier one-time blocks accept both spellings; seed.py creates QS).
> **Phase 2 WAVE 2 DELIVERED (same day)** — kpis.py (plant-aware `_machine_cond`/`_machine_int_cond`/
> `_oee_metrics`; wrong-plant machine/equipment id probes 404 on every KPI endpoint), costs.py
> (`_resolve_site`: the QS/QM site filter is locked to the caller's memberships — single-site users
> forced to their site, cross-site → 403, dual-membership/corporate keep free choice incl. combined;
> full plant_id refactor of `_site_of` stays phase 3), factory_map.py (path plant validated on GET/
> floor-plan/zones/props; zone/prop by-id checks; **WS now verifies the token user's membership for
> the requested plant**), reports.py (entity resolution plant-checked incl. transient machines;
> compare scoped). Validated: MIRA-only persona → KPIs plant-only (4 vs 50 failures), SJ map/report/
> KPI probes 404, P&L locked to the 4 Mirabel cost centers, site=QS → 403; admin free in both
> contexts; map UI follows the header's active plant.
> **Phase 2 WAVE 3 DELIVERED (same day) — READ-PATH SCOPING COMPLETE.** machines.py stop/reject
> category config + operators + clone endpoints all verify the machine ref (scoped helper);
> maintenance_plans.py (list/calendar/PM-dashboard scoped, create guards equipment+template+technician;
> router-level `path_plant_guard` on plan_id AND occurrence_id); pm_template_settings.py (list scoped,
> create guarded, router guard on template_id — NOTE: real prefix is `/api/settings/pm-templates`,
> CONTEXT.md's `/api/pm-templates` is stale); service-level WO creation now stamps plant everywhere
> (pm_service cron, ticket_service assign/generate). Dashboards (custom) stay global BY DESIGN:
> they are tile layouts — the data each tile fetches comes from already-scoped endpoints, so a shared
> dashboard shows each viewer their own plant's numbers. Validated: MIRA persona sees 0 plans/templates
> (all are QS), SJ ids → 404; admin 5/5 in QS ctx, 0 in QM ctx; tests 7/7; tsc clean.
> **Phase 3 DELIVERED (same day) — per-plant configuration.**
> *Escalation/notifications:* `get_escalation_settings(db, plant_id)` = own row wins, else the legacy
> shared row (QS+QM keep editing one row as today; NL gets its own at onboarding). Contact rule: an
> explicit per-plant contact fires only for its plant; a legacy (NULL) contact fires ONLY for plants
> its user holds a user_plants membership in — shared QC team keeps both plants' alerts, NL notifies
> nobody until configured. Role-fallback recipients and the claimable-technician pool are membership-
> filtered too. Escalation loop resolves SLAs per alert plant (cached per sweep); shift reports are
> generated per plant (group key, dedup, recipients, enablement, ShiftReport.plant_id).
> *Calendar:* a plant OWNING a FactoryCalendarSettings row uses exclusively its own calendar+holidays;
> otherwise the legacy shared one (QC today). `working_dates(..., plant_id=)` infers from machines;
> `/api/calendar` edits the active plant's calendar. Constraints moved: factory_holidays unique →
> (plant_id, date) NULLS NOT DISTINCT; maintenance_budgets → (plant_id, year, month).
> *Numbering:* `series_prefix(db, plant_id)` — ungrouped plants get code-prefixed series
> (NL-WO-2026-00001); QC keeps the shared historical series. Wired into WO/TKT/ALT/PO generators.
> *Write stamping completed everywhere:* kiosk call/stop/reject/production paths, machine_operator,
> mes_service, intervention_sync — new rows carry plant at creation (no boot-heal wait).
> Verified by rollback-only checks (4/4: numbering, settings fallback/override, membership contacts,
> calendar) + calendar API identical in QS/QM contexts + regression 200s + tests 7/7. **No real SMS
> was triggered during verification.**
> **DECISION (deviation from original phase-3 plan):** the deep costs refactor (`_site_of` name rule →
> plant_id columns in `_cc_actuals`/`_wo_type_actuals`/…) is intentionally NOT applied: for WO-derived
> actuals the name rule (cost-center) and plant_id (equipment) can legitimately disagree, so swapping
> silently could move numbers between QS and QM on financial reports. The membership lock
> (`_resolve_site`) already isolates plants; the repartition-basis change needs a business sign-off
> first (flagged to the user).
> **Phase 4 DELIVERED (same day) — unauthenticated surfaces.**
> *Live WS (`/api/live/ws`):* token → user → allowed plants at connect; machine-scoped events whose
> machine belongs to another plant are dropped (ref→plant memoized per connection); corporate admin
> unfiltered; broadcast/badge hints pass (no record data — their refetch is REST-scoped).
> *Kiosk tokens:* `machines.kiosk_token` + `POST /api/machines/{ref}/kiosk-token` (authed, scoped,
> returns `/machines/<slug>?k=<token>`); `core/kiosk_guard.py` router-level guard on the machines
> router (param `ref`) and machine_operator router (param `machine_id`): kiosk token match OR bearer
> user with membership in the machine's plant. **Gated by `KIOSK_ENFORCE_TOKEN` env, default FALSE**
> — historic open kiosks unchanged until tablets are re-bookmarked (NL onboarding flips it, or an
> ops window for QC). Guard branches proven in-process (no-token 403 / token pass / wrong-token 403);
> open-behavior regression confirmed (unauth kiosk page + state = 200). Frontend: MachinePage stores
> `?k=` in sessionStorage; axios sends `X-Kiosk-Token` (dormant).
> *job_orders:* authed list/create/update scoped + plant stamped via machine (kiosk exact-number
> lookup stays open — needs the exact number; covered once enforcement is on is NOT true: it has no
> machine param → documented residual, low risk). *robot_cells:* list/detail scoped.
> *Media (`/api/media`):* ACCEPTED RISK — filenames are `uuid4().hex` (unguessable); browser `<img>`
> tags can't send Authorization headers and kiosks are tokenless, so header-auth would break all
> embedded media. Signed URLs are the future fix if needed. machine_operator auto-provision now
> stamps the equipment's plant.
> **Phase 5 DELIVERED (same day) — Ask Ninja + RLS defense-in-depth.**
> *RLS:* 38 `plant_isolation` policies (ENABLE + FORCE), FAIL-OPEN when the `app.plant_ids` GUC is
> unset — normal sessions/crons/migrations unaffected; app-layer PlantContext stays primary.
> KEY FINDING: `mesadmin` is the bootstrap SUPERUSER and superusers bypass RLS entirely (even FORCE)
> — so Ask Ninja's SQL now runs under a dedicated non-superuser read-only role (`kaizo_ninja`,
> `SET LOCAL ROLE` inside its READ ONLY txn), where the policies DO apply; the role can only SELECT
> and has no access to `password_reset_tokens`/`user_invitations`. Group-scoped tables (stock_items,
> suppliers) read a second GUC (`app.plant_ids_grouped` = union of the groups of the user's allowed
> plants) so SQL visibility matches the UI's QC-pool semantics. Request-path RLS (per-request GUC on
> app sessions) would need a non-superuser app login — documented as future hardening, not required.
> *Ask Ninja:* `answer_question`/`_run_tool` now take PlantContext (this ALSO fixed a wave-2 breakage:
> the compare_machines/maintenance_overview tools were still passing `current_user=` to route
> functions whose signature became `ctx=`). Curated tools plant-filtered (list_assets, machine
> resolution, purchasing = plant POs, inventory = group pool, findings per active plant via
> `build_findings(plant_id=)`); raw SQL fenced by RLS for non-corporate, unscoped for corporate.
> Verified with the QM persona: raw SQL sees 506/8,219 WOs, 12 machines, 1 ticket, QC stock pool
> 5,440, credential tables blocked; tool dispatcher returns QM-only entities; regression 200s; 7/7.
> *Known deferred:* AI insights cron still generates QC-wide (plant NULL) insights — flip to
> per-plant generation + scope insight reads BEFORE creating NL users (NL onboarding blocker).
> **Phase 6 DELIVERED (same day) — Las Vegas (NL) onboarded, fully isolated.**
> *AI insights per plant (was the blocker):* `_intelligence_cron` now loops active plants
> (`build_findings(plant_id=)`, `AIInsight.plant_id` stamped); `/generate` defaults to the active
> plant and validates explicit ones; `/latest` + `/history` filter by plant — legacy NULL insights
> (QC-era content) stay visible ONLY to grouped plants, an ungrouped plant (NL) never sees them;
> risk-scores scoped via Machine join, spare-parts-risk via StockItem (group pool).
> *Plant currency:* `plants.currency` (QC=CAD, NL=USD).
> *NL created* (one-time `nl_onboarding_2026_07_10`): code NL, America/Los_Angeles, USD,
> group_code NULL (own inventory/supplier pool + own `NL-WO-…` numbering), own escalation row with
> **SMS/email disabled** until NL contacts exist, own calendar row (Quebec holidays NOT inherited).
> **No membership granted to anyone** — NL access is assigned explicitly in Settings → Users.
> Verified: admin selector shows QS/QM/NL; QM persona sees only QM (plants list hides NL; forced NL
> ctx → 403); admin in NL ctx: 0 machines/WOs/stock (isolated pool), 0 holidays, insights 404 (QS
> ctx still 200), numbering `NL-`, escalation own row sms=False; tests 7/7.
> **NL go-live ops checklist (people/data, not code):** create NL users + memberships (Settings →
> Users); register NL equipment/machines (born in NL via active context); provision kiosk tokens +
> re-bookmark tablets + flip `KIOSK_ENFORCE_TOKEN`; add Nevada holidays (Settings → Calendar, NL
> context); configure NL escalation contacts then enable SMS; NL cost centers/SAP wiring when its
> GL exists (costs page `_resolve_site` currently 403s NL-only users off the QC ledger by design).
> **Phase 7 DELIVERED (same day) — test matrix + docs. ALL 7 PHASES COMPLETE.**
> Durable suite `backend/tests/test_plant_segregation.py` (8-persona matrix — QS-only, QS+QM
> role-per-plant, QM-only, NL-only, NL supervisor, corporate admin, no-plant, disabled-at-HTTP:
> context resolution, scoped lists, 404 record probes, cross-plant technician block, membership
> notifications, per-plant numbering, calendar ownership, RLS raw-SQL fence, kiosk guard branches);
> assertions are structural (row ownership), not fixed counts. HTTP battery
> `backend/scripts/plant_security_check.py` (18 checks: membership surface, forced-context 403s,
> direct-id 404s across tickets/WOs/machine-history/plants/factory-map/reports, cost-site lock, NL
> isolation, admin dual-context regression). Results: **full suite 82 passed** (incl. the parallel
> labor-test fix), **HTTP battery 18/18**. Closing docs: CONTEXT.md §15 (architecture summary) +
> this file. Standing artifacts for regression: the two pytest files, the HTTP script, the QM persona
> `test-mira-only@kaizo-test.com`, and `scripts/plant_backfill_report.sql`.
> Date: 2026-07-10. Ground truth verified against the live DB (`mes_db`) and the code at `C:\KAIZO`.
> Scope: introduce Las Vegas (LV) as a fully segregated plant while preserving Saint-Jérôme (SJ) +
> Mirabel (MIRA) shared-management workflows.

---

## 1. Executive summary

**Recommendation: single application, single database, plant-aware architecture (Option 2),
with PostgreSQL row-level security added as a phase-2 defense-in-depth layer. Do not duplicate
the stack for Las Vegas.**

Decisive facts from this codebase (not general principles):

1. **The schema was designed for this.** `models.py` line 3 says "Structured for multi-plant
   support from the ground up": `plants`, `user_plants(user_id, plant_id, role)` and
   `permissions.plant_id` already exist; `equipment.plant_id` is NOT NULL; ~15 more tables already
   carry a nullable `plant_id`. UUID PKs everywhere were chosen explicitly for multi-plant.
2. **Two plants already exist in production** (`PLT1` Saint-Jérôme, `MIRA` Mirabel; 359 + 76
   equipment) — **and the app does not segregate them at all today**. Every list endpoint
   (`machines`, `tickets`, `alerts`, `work_orders`, `technicians`, `inventory`, KPIs, dashboards)
   returns both plants mixed. The Costs page separates "sites" by **pattern-matching the cost-center
   name** (`"mirabel" in cost_center.lower()`, `costs.py:118`). So the plant-scoping work is owed
   *regardless of Las Vegas* — duplication would not avoid it.
3. **Migrations are idempotent SQL run at startup** (`main.py::_run_migrations`, no Alembic) and
   deployment is a single hand-operated Docker Compose stack. A second stack means two DBs applying
   startup migrations at independent times, two `.env`s, two backup jobs, two nginx configs —
   version drift is near-certain with this tooling.
4. **Corporate access is a stated future requirement.** Separate instances make an all-plants
   dashboard, single sign-on, and consolidated reporting impossible without building a third system.

Duplication *would* be simpler for ~2 weeks and safer against cross-plant bugs by construction, but
it permanently doubles operations, forks configuration, kills corporate reporting, and still leaves
SJ/Mirabel unsegregated. The single-app path costs more up front (touching ~35 routers) but is the
only one consistent with the existing half-built multi-plant schema and the business requirements.

---

## 2. Current state (ground truth)

### 2.1 Stack & deployment

- One Docker Compose stack: `db` (TimescaleDB PG16), `redis`, `mqtt`, `backend` (FastAPI),
  `iot_worker`, `adam_gateway`, `ollama`, `frontend` (nginx-served build), `nginx`, `backup`
  (postgres-backup-local). Volumes incl. `uploads_data`.
- Schema managed by `Base.metadata.create_all` + ~500 idempotent SQL statements in
  `main.py::_run_migrations` at startup; one-time steps guarded by the `_kaizo_migrations` marker
  table.
- Background work: in-process asyncio crons in FastAPI lifespan (`_escalation_loop` 60s, `_pm_loop`
  1h, `_shift_report_loop` 60s, intelligence cron) + `iot_consumer` (MQTT) + `adam_gateway` workers.
- Media: uploads require auth (`uploads.py`), but files are **served unauthenticated** via
  `app.mount("/api/media", StaticFiles(...))` (`main.py:1185`) — security by unguessable filename.

### 2.2 Identity, auth, permissions

- JWT (`sub` = user id, `role`) → `get_current_user` (`core/security.py`). Token + user persisted in
  **localStorage** (`authStore.ts`, key `foliot-auth`; CONTEXT.md's "memory only" claim is stale).
- `User.role` is a **single global role**; `UserRole` enum: operator, technician, supervisor,
  maintenance_director, plant_manager, director, admin.
- `user_plants` (role per plant) exists **but is never consulted by authorization**. 10 rows exist.
  `users.py` already has endpoints to assign/remove user↔plant links.
- Permission system (`core/permissions.py`): admin bypass; per-user allow-list overrides
  (`permissions` table) else role defaults. **`resource_guard` only guards writes — every GET
  passes with mere authentication.** View-gating lives in the frontend (`RequireView`/`can()`).
  Cross-plant reads are therefore possible today for *any* authenticated user by direct API call.
- **Unauthenticated surface (by design, shop-floor kiosks):** all of `machine_operator.py`
  (state, call, start/complete intervention, checklist, parts, `list_kiosk_technicians` — exposes
  technician names) take only `Depends(get_db)`. Machine signal ingest uses per-machine
  `signal_ingest_token`; robot cells use per-cell `ingest_token`.

### 2.3 Plant model today (live DB, 2026-07-10)

| Fact | Value |
|---|---|
| `plants` rows | `PLT1` "Foliot Furniture (Saint-Jérôme)", `MIRA` "Foliot Furniture (Mirabel)" — both America/Toronto |
| `equipment` | 359 → PLT1, 76 → MIRA (plant_id NOT NULL, fully assigned) |
| `machines` | 44 → PLT1, 12 → MIRA, **14 → NULL (orphans — need review)** |
| `stock_items` | **All 5,440 rows → PLT1** (Mirabel inventory not separated) |
| `user_plants` | 10 rows (unused by auth) |
| `users` | 27 (23 technician, 1 supervisor, 1 maintenance_director, 1 director, 1 admin) |

### 2.4 Table ownership inventory (~70 tables)

**Direct `plant_id`, NOT NULL:** `equipment`, `factory_zones`, `map_props`.

**Direct `plant_id`, nullable:** `machines` (14 NULL), `maintenance_plans`, `pm_templates`,
`plan_occurrences`, `stock_items`, `shift_templates`, `intervention_types`, `machine_interventions`,
`safety_checklists`, `ai_insights`, `dashboards`, `permissions`, `user_invitations`.

**Derivable via FK (1 hop or 2):** `work_orders` (equipment_id / machine_id), `maintenance_alerts`,
`maintenance_tickets`, `machine_stops`, `machine_production_logs` / `_hourly` (hypertable),
`reject_logs`, `job_orders`, `machine_history`, `machine_operators`, `stop_categories` /
`reject_categories` (machine-linked ones; `is_global=TRUE` rows are platform-wide),
`sensors`, `sensor_readings` (hypertable), `alerts` (IoT), `robot_cells` (equipment_id),
`wo_parts` / `wo_costs` / `wo_actions` / `labor_records` / `work_order_technicians`
(work_order_id), `intervention_*` (intervention_id), `inventory_movements` (stock_item_id),
`purchase_order_items` (order_id), `pm_template_tasks` / `pm_task_media` (template_id),
`plan_recommended_parts` (plan_id), `notification_logs` (alert/ticket id), `ticket_comments`,
`cost_audit_log` (work_order_id), `shift_breaks` (shift_template_id),
`technician_unavailabilities` (technician_id).

**No ownership path at all (global today, decision needed):** `users` (via user_plants),
`technicians` (via user — needs explicit plant), `suppliers`, `purchase_orders`,
`escalation_settings` (singleton), `escalation_contacts` (have machine/department scope but no
plant), `factory_calendar_settings` + `factory_holidays` (Quebec holidays ≠ Nevada!),
`cost_centers`, `cost_center_budgets`, `maintenance_budgets`, `sap_cost_lines` (site = QS/QM by
cost-center *name matching*), `shift_reports`, `email_logs`, `adam_devices`, `job order` numbering,
document numbering series (below).

### 2.5 Cross-plant leak paths found (each must be closed)

| # | Path | Where | Severity |
|---|---|---|---|
| 1 | Every list/detail endpoint is plant-blind; GETs pass with auth only | all ~35 routers | **critical** |
| 2 | Ask Ninja `query_database` — arbitrary read-only SQL over the whole DB | `intelligence_chat.py` | **critical** |
| 3 | Kiosk endpoints unauthenticated (state, technicians list, interventions) | `machine_operator.py` | high |
| 4 | Realtime WS broadcasts every event ref to every connected browser | `event_bus.py`, `live.py`, factory-map WS | medium (ids only) |
| 5 | Escalation/SMS contacts are global — a LV alert would text SJ managers | `escalation_settings/contacts` | high |
| 6 | Costs site = cost-center name matching; budgets/SAP lines have no plant | `costs.py:107-118` | high |
| 7 | Media served without auth (`/api/media`) | `main.py:1185` | medium |
| 8 | Document numbers are one global series (`WO-2026-NNNNN`) — leaks volume, collides plants | `numbering.py` | low/medium |
| 9 | Dashboards/KPIs/reports aggregate across all plants | `kpis.py`, `reports.py`, `maintenance_dashboard.py` | high |
| 10 | `plants` CRUD requires only authentication (any user can create/edit plants) | `plants.py` | medium |
| 11 | Frontend caches (localStorage auth/user, per-page state) survive plant switches | `authStore.ts` etc. | medium |
| 12 | Hardcoded default TZ `America/Toronto` in services (fallbacks) | `labor_time_service.py:46`, `kpis.py:22`, `notification_service.py:27` | low (LV = America/Los_Angeles) |

### 2.6 Configuration inventory

- **Already per-plant capable:** plant timezone, floor plan, factory zones, shift templates
  (nullable plant_id), machine-level: kiosk language (default 'fr' — LV wants en/es), hourly rate +
  currency, stop/reject taxonomies (machine-linked).
- **Global today but must become per-plant:** escalation settings + contacts + quiet hours + SMS
  templates, factory work calendar + holidays, cost centers/budgets/SAP mapping, document numbering
  series, default currency (CAD vs USD for LV), shift report windows.
- **Legitimately global:** branding, app languages (en/fr/es), permission resources, role
  definitions, units.

---

## 3. Options analysis

### Option 1 — Separate Las Vegas deployment (duplicate stack)

| Dimension | Assessment |
|---|---|
| Data security / leakage | Excellent by construction (separate DB) — including Ask Ninja and kiosks |
| Auth | Two user stores, two logins, no SSO; corporate users need 2 accounts |
| Maintenance / code duplication | Same repo/images possible, but **every deploy, migration, .env change, nginx config, backup job ×2**, applied by hand |
| Version drift | Near-certain: startup-SQL migrations applied whenever each stack restarts; no CI/CD |
| Corporate reporting | Impossible without a 3rd system (warehouse/ETL) |
| SJ/Mirabel problem | **Unsolved** — they stay co-mingled; plant scoping still owed |
| Cost | Second host/VM, second Twilio/Anthropic config, double monitoring & backups |
| Time to LV go-live | Fastest (~days): clone stack, fresh volumes, seed |

### Option 2 — Single app, plant-aware (recommended)

| Dimension | Assessment |
|---|---|
| Data security | Enforceable at one choke point (FastAPI dependency) + DB RLS as 2nd layer; testable |
| Leakage risk | App-bug risk exists → mitigated by centralized scoping, negative tests, RLS |
| Auth | One store; `user_plants` role-per-plant already modeled; corporate = multi-membership |
| Maintenance | One codebase, one migration path, one deploy |
| Reporting | Per-plant and (authorized) cross-plant from the same DB |
| Regression risk to SJ/MIRA | Main cost — ~35 routers touched; mitigated by phased rollout with behavior-preserving defaults (existing users get SJ+MIRA membership) |
| Cost | No new infra; engineering effort up front |

### Option 3 — Hybrid (one codebase, two deployments)

Gets hard isolation and avoids code forking, but keeps double ops/config/backups, still blocks
corporate reporting, still requires plant scoping inside the SJ/MIRA instance, and retains the
migration-drift risk (two DBs migrating at independent restart times). It is Option 1 with better
hygiene — worth considering **only** if a hard compliance rule ever mandates physically separate
data residency for Nevada. No such requirement is on the table.

### Explicit answers

- **Would duplicating truly be simpler?** Short-term yes; total-cost no. It doubles the weakest
  part of this operation (manual compose deploys, startup migrations, backups) forever.
- **Would duplication create maintenance/version problems?** Yes — schema drift between two DBs
  migrated at independent restarts, config drift across two `.env`s, features tested twice.
- **Can secure segregation be implemented in the current app?** Yes. FastAPI DI gives a single
  enforcement point; the schema is half-migrated already; PG16 supports RLS (incl. hypertables).
  It requires closing the "reads unguarded" gap and the kiosk surface — which are pre-existing
  security debts anyway.
- **Safest migration path?** Phased and behavior-preserving: build the plant context first with all
  existing users granted SJ+MIRA membership (no visible change), enforce read scoping router group
  by router group behind validation tests, only then onboard LV users.

---

## 4. Recommended architecture

### 4.1 Access model

- **Membership table:** keep and promote `user_plants (user_id, plant_id, role)` to the
  authoritative source of plant access + per-plant role. Add `is_default BOOLEAN`, uniqueness on
  `(user_id, plant_id)`, and audit columns (`granted_by_id`, `created_at`).
- **Global role:** `User.role` remains only as (a) `admin` = corporate super-user (all plants,
  bypass) and (b) fallback/default role template at invitation time. All other authorization
  resolves the **role for the active plant** from `user_plants`.
- **Rules:** no membership rows + not admin → no plant access (safe deny). One membership → that
  plant auto-selected, no selector. Multiple → selector in Header, default = `is_default`.
- Per-user permission overrides: `permissions.plant_id` (column already exists) scopes an override
  to a plant; NULL = applies to all the user's plants.
- Invitations: `user_invitations.plant_id` (exists) becomes required; accepting creates the
  membership row. Offboarding = delete membership rows (audited), not the user.

### 4.2 Plant context protocol

- Frontend sends `X-Plant-Id: <uuid>` on every request (axios interceptor; persisted per-user).
- Backend dependency `PlantContext` (new, `core/plant_context.py`):
  1. authenticate user → load memberships (one cheap JOIN, same request as `get_current_user`);
  2. resolve requested plant: header value must be in the allowed set, else **403**; missing header
     → user's default plant (never "all");
  3. expose `ctx.plant_id`, `ctx.role` (role at that plant), `ctx.allowed_plant_ids`,
     `ctx.is_corporate`.
- Detail routes: after loading a record, verify its (direct or derived) plant ∈ allowed set →
  **404** on failure (not 403 — no existence leak).
- "All my plants" aggregate views (corporate dashboards) are explicit endpoints/parameters that
  expand to `ctx.allowed_plant_ids`, never an implicit default.
- Every scoped query goes through central helpers (e.g. `scoped(select(Machine), ctx)`) — one
  ownership map: model → direct column or join path. **No per-route hand-written plant filters.**

### 4.3 Enforcement layers

1. **App layer (phase 1):** `PlantContext` + scoped query helpers + relational-integrity
   validators on writes (ticket.machine.plant == ctx.plant; WO assignee must hold membership in the
   WO's plant; intervention parts must come from same-plant stock; PO ↔ supplier ↔ plant, etc.).
2. **DB layer (phase 2, defense-in-depth):** PostgreSQL RLS with a per-request
   `SET LOCAL app.plant_ids` GUC issued in `get_db` / worker sessions. Policies
   `USING (plant_id = ANY (current_setting('app.plant_ids')::uuid[]))` on tables carrying
   plant_id. Verified constraints for this stack: RLS works on Timescale hypertables;
   **continuous aggregates (`machine_production_daily`) do not enforce RLS** → they must be
   filtered by plant in the querying code or excluded from Ask Ninja's schema. Crons/workers run
   with an all-plants setting. RLS also makes **Ask Ninja's arbitrary SQL plant-safe** (its READ
   ONLY connection gets the same GUC).
3. **Until RLS lands:** Ask Ninja SQL tools (`describe_schema`, `query_database`) are restricted
   to corporate all-plants users; the 5 curated maintenance tools get plant filters immediately.

### 4.4 Specific subsystems

- **Realtime:** include `plant_id` in every `event_bus.publish`; `/api/live/ws` and the factory-map
  WS resolve the token → allowed plants at connect time and drop events for other plants.
- **Notifications/escalation:** `escalation_settings` and `escalation_contacts` gain `plant_id`
  (settings become one row per plant; current row → SJ+MIRA as configured today). The escalation
  loop resolves contacts by the alert's plant. Shift reports likewise.
- **Numbering:** per-plant series going forward (`plants.code` prefix for new LV docs, e.g.
  `LV-WO-2026-00001`); existing SJ/MIRA numbers unchanged (`numbering.py` takes a prefix already).
- **Calendar:** `factory_calendar_settings`/`factory_holidays` gain `plant_id`; KPI helpers
  (`working_dates()`) take the plant.
- **Costs:** `cost_centers`, `cost_center_budgets`, `maintenance_budgets`, `sap_cost_lines` gain
  `plant_id`; replace `_site_of()` name matching with the explicit column (QS→PLT1, QM→MIRA
  backfill uses the *existing* name rule once, documented, then the rule is deleted). Plant gains
  `currency` (CAD / USD for LV).
- **Kiosk:** per-machine kiosk token embedded in the kiosk URL (same pattern as
  `signal_ingest_token`), validated by `machine_operator.py`; endpoints additionally verify the
  machine's plant matches the token's plant. LV tablets therefore cannot read SJ machine state.
- **Media:** move `/api/media` behind an auth+plant check (or signed URLs); phase 4.
- **Frontend:** `plantStore` (active plant, memberships); selector only when >1 membership; active
  plant always visible; switching resets page state/caches; per-plant persisted filters keyed by
  plant id.
- **Audit:** plant_id added to `wo_actions`, `cost_audit_log`, `notification_logs`; new
  `access_audit` table for plant switches, denied cross-plant attempts, membership/permission
  changes, exports.

---

## 5. Migration & backfill plan

**Mechanism:** same as the codebase uses today — additive idempotent SQL in `_run_migrations`,
one-time steps guarded by `_kaizo_migrations` keys. All new columns nullable first; constraints
added only after backfill validation.

1. **Backup:** verify `mes_backup` output + manual `pg_dump` immediately before rollout.
2. **Schema:** add `plant_id` (nullable, FK, indexed) to the "derivable" and "no ownership" tables
   listed in §2.4; composite indexes `(plant_id, <hot timestamp>)` on tickets, alerts, WOs, stops,
   production logs.
3. **Backfill (documented inference rules):**
   - via machine: tickets, alerts, stops, production, rejects, history, job orders, operators,
     interventions (machine → plant);
   - via equipment: WOs (equipment.plant_id; else machine_id), sensors/readings, robot cells;
   - via parent: all WO/intervention/PO children need no column (parent-scoped);
   - technicians ← their user's `user_plants` (single membership) else **report**;
   - cost centers ← the current QM/QS name rule (one-time, then rule deleted);
   - `escalation/calendar/settings` singletons → duplicated per existing plant with current values.
4. **Ambiguity report (no guessing):** generate `docs/plant-backfill-review.csv` listing records
   whose plant cannot be inferred — known already: **14 machines with NULL plant_id**, technicians
   with 0 or 2+ memberships, stock split question (all 5,440 items sit in PLT1 — does Mirabel hold
   inventory?), suppliers (shared corporate vs per-plant). These get assigned by a human before
   constraints tighten.
5. **Validation queries:** per table: NULL-plant count; cross-plant FK mismatch count (e.g. ticket
   plant ≠ machine plant must be 0); totals per plant vs pre-migration totals (no row lost/dup).
6. **Rollback:** additive-only schema (nullable columns + new tables) → rollback = deploy previous
   image; data rollback = restore dump. No destructive statement in the whole plan.
7. **Constraints (last):** NOT NULL where the table logically requires a plant; trigger/CHECK
   guards on the highest-risk relations (ticket↔machine, WO↔equipment, intervention↔machine,
   inventory_movement↔stock_item same-plant).

---

## 6. Phased implementation

| Phase | Content | Risk |
|---|---|---|
| 0 | `PlantContext` + membership resolution + `/auth/me` returns memberships; frontend plantStore + header selector; **all existing users backfilled with SJ+MIRA membership (proposed list reviewed by you first)** — zero behavior change | low |
| 1 | Schema additions + backfill + ambiguity report (§5) | low (additive) |
| 2 | Read-path scoping via central helpers, router group by group: machines/kiosk-admin, tickets/alerts, WOs, technicians/schedule, inventory/suppliers/POs, PM, KPIs/dashboards/reports/costs, factory map, settings | **main effort** |
| 3 | Write-path relational guards; per-plant escalation/calendar/numbering/costs | medium |
| 4 | Kiosk tokens, media auth, WS plant filtering, plants-CRUD admin-only, Ask Ninja gating | medium |
| 5 | RLS + GUC (defense-in-depth), access audit, cagg handling | medium |
| 6 | LV onboarding: plant row (America/Los_Angeles, USD), configs, users, equipment/machines, kiosks, escalation contacts | low |
| 7 | Security test matrix + SJ/MIRA regression pass | — |

## 7. Test matrix (summary)

Personas: SJ-only mechanic · SJ+MIRA maintenance manager · MIRA-only operator · LV-only mechanic ·
LV supervisor · corporate admin · user with no membership · disabled user.

Per persona × module (tickets, WOs, machines, schedule, inventory, PM, KPIs, costs, map, settings):
view / create / edit / assign / schedule / close / delete / export / switch-plant. Negative tests:
direct ID probes (expect 404), list counts (expect plant-only totals), search/autocomplete,
notifications recipients, WS event stream content, media URLs, Ask Ninja prompts asking about the
other plant, dropdowns (technician/machine/part selectors), invitation flow, kiosk endpoints with
wrong-plant tokens. Automated in `backend/tests/` (pytest infra already exists).

## 8. Open business decisions (blocking specific steps only)

1. The **14 machines with `plant_id NULL`** — assign (likely cobot/simulated rows).
2. **Mirabel inventory**: split from PLT1 stock or keep a shared SJ+MIRA warehouse? (Affects stock
   scoping mode: per-plant vs plant-group.)
3. **Suppliers**: shared corporate list vs per-plant. Recommended: per-plant with optional sharing
   later; LV builds its own list.
4. Which SJ users get MIRA membership (and vice-versa) — review list before backfill.
5. Ask Ninja availability for single-plant users before RLS lands (recommend: corporate-only until
   phase 5).
6. LV defaults: currency USD, kiosk language, shift structure, escalation contacts.

## 9. Known limitations / notes

- In-process event bus and crons assume a single backend process; per-plant WS filtering keeps that
  model (documented in `event_bus.py`).
- Continuous aggregates bypass RLS — handled explicitly (§4.3).
- Within-plant view permissions on GETs remain frontend-gated as today (pre-existing design);
  plant segregation itself is enforced server-side by `PlantContext` — this assessment does not
  change the intra-plant permission philosophy.
- CONTEXT.md §1 note "Las Vegas → separate instance" is superseded by this document.
