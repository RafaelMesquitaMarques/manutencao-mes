# Ordres de fabrication (OF) — architecture

Status: **All 5 phases shipped.** Data foundation + scan wiring + cost per OF + OF page
+ 3D-map conveyor panel + external ingest (Cortex + smart-label, provisional skeletons).

## Goal

Scan an OF (Ordre de fabrication) at each machine kiosk to:

1. Compute **time + production cost** per OF and factory total — reports kept **≥10 years**.
2. Track **WIP** — where each OF is, and how much (%) sits in each department/machine.
3. **Attribute pieces** produced to the OF loaded at the time.
4. Give OFs a **dedicated page** (status, filters by department, etc.).

## Terminology

**Ordre de fabrication (OF)** is the canonical domain term (plant is FR/Quebec).
User-facing labels: FR "Ordre de fabrication" / "N° d'OF", EN "Production Order",
ES "Orden de fabricación". Code identifiers stay technical and are **not** renamed
or translated: `JobOrder`, `job_orders`, `job_number`, `/api/job-orders`.

## Decisions (2026-07-10)

- **No routing yet.** WIP = the machine where the OF was last scanned. A planned
  route (sequence of departments/machines) is an optional later layer.
- **OFs are created on the fly** from three sources — the `source` enum is
  `manual | erp | cortex | smart_label`:
  - `manual` — typed/scanned in the machine kiosk ("N° DE JOB" field).
  - `cortex` — the Cortex system scans the label to fetch the cobot program.
  - `smart_label` — born when the **cutting department** prints the smart label
    (the label carries the OF number through the plant).
- **Cost = machine-time × `machine.hourly_rate`** in v1. Labor (effective-labor-time)
  and material/BOM come later.
- **One open run per OF** — an OF is physically in one place, so scanning it on a
  machine closes any open run it still has elsewhere. WIP location is therefore the
  single open run of an OF.
- **OF numbers are unique per plant, not globally.** Mirabel is the supplier factory
  for St-Jérôme and Las Vegas, so the same number can legitimately exist in different
  plants. Uniqueness is `(plant_id, job_number)`; every lookup/create is scoped to the
  scanning machine's plant so a scan never resolves to another plant's OF.

## Data model

### `job_orders` (`JobOrder`) — the OF header

`machine_id`/`department` hold the **current (last-scanned)** location; the full path
lives in the runs. Reconciled 2026-07-10 (the original DDL used `description`; the
model/schema use `product_name` + `scheduled_date`/`erp_reference`/`department`/
`started_at`/`completed_at`). Idempotent `ADD COLUMN IF NOT EXISTS` guarantees every
column exists regardless of how the table was first created.

Key fields: `job_number` (globally unique), `product_name`, `target_quantity`,
`scheduled_date`, `department`, `status` (pending→in_progress→completed/cancelled),
`source`, `erp_reference`, `started_at`, `completed_at`.

### `job_order_runs` (`JobOrderRun`) — the keystone, one "passagem"

One row per scan: an OF's stay on a machine from the moment its number is scanned
there until a different OF is scanned (or it moves / is cleared). This single table
powers **both** cost (Σ `duration_minutes` × `machine.hourly_rate`) **and** WIP (an
open run = the OF's current location). Low volume (one per scan) → plain
Postgres/Timescale, retained ≥10 years.

Fields: `job_order_id`, `machine_id`, `plant_id`, `department` (snapshot),
`operator_id`, `started_at`, `ended_at` (NULL = live), `duration_minutes`, `pieces`,
`rejects`, `source`.

Indexes: `(job_order_id, started_at)`, `(machine_id, started_at DESC)`,
`(plant_id, started_at DESC)`, and a **partial unique** index
`uq_jobruns_open_per_machine` on `(machine_id) WHERE ended_at IS NULL` — at most one
open run per machine.

### Production attribution

`machine_production_hourly` gained a `job_number` column; `MachineProductionLog` and
`MachineStop` already had one. These are stamped **best-effort** with the current OF;
the **authoritative** per-OF piece count is `JobOrderRun.pieces`.

## Scan flow — `app/services/job_order_service.py`

All three sources funnel through `scan_job_order_at_machine(db, machine, job_number,
source, ...)`:

1. Empty/None number → **clear**: close the machine's open run, clear
   `machine.current_job_number`.
2. Otherwise lookup-or-create the OF by `job_number`.
3. Re-scanning the OF already loaded here → no-op.
4. Else close the machine's current open run (frees the per-machine slot), close the
   OF's open run on any other machine (it moved here), open a new run, set the OF
   `in_progress` + `started_at`, and record it as the machine's/OF's current location.

`attribute_production(db, machine_id, pieces, rejects)` adds parts to the open run and
returns the OF's `job_number` for stamping the OEE/hourly rows. No commits inside the
service — callers commit so a scan lands atomically.

### Wiring (Phase 1)

- `PATCH /api/machines/{ref}/job` (kiosk field) → `scan_job_order_at_machine(..., manual)`.
- `POST /api/machines/{ref}/production-count` (ADAM feed) → `attribute_production` then
  stamps `job_number` on the shift log + hourly bucket.
- `MachineStop.job_number` already falls back to `machine.current_job_number` on create.

### API

`/api/job-orders`: `GET /` (filters machine/number/status), `GET /lookup` (kiosk,
unauth), `GET /cost-report`, `POST /` + `POST /kiosk`, `GET /{id}`, `GET /{id}/runs`
(the OF timeline), `GET /{id}/cost`, `PATCH /{id}`. `cost-report` is declared before
`/{id}` so the static path isn't parsed as an id.

## Cost per OF (Phase 2) — `app/services/job_order_cost_service.py`

**Cost of an OF = productive machine time × the machine's `hourly_rate`.** Productive
time is a run's wall-clock presence MINUS any stop time overlapping it. Business rule
(2026-07-10): **stop/downtime is never attributed to an OF** — it's tracked separately
in the existing machine downtime analytics. An OF only costs the machine while running.

- `_stop_seconds_in_window(machine, start, end)` sums ALL `machine_stops` (planned or
  not) overlapping the run window, ongoing stops capped at `end`. Reuses
  `overlap_seconds`/`_as_utc` from `mes_service`.
- `_run_cost(run)` → gross vs stop vs productive minutes, pieces, rate, currency, cost.
- `compute_job_order_cost(of)` → per-run detail + `by_machine`/`by_department` buckets +
  totals (`GET /{id}/cost`, `JobOrderCostOut`).
- `compute_cost_report(base_query, date_from, date_to)` → per-OF rows + factory total,
  plant-scoped, optional date window on run start (`GET /cost-report`,
  `JobOrderCostReportOut`). Currency is the plant's (report is plant-scoped).

Machine hourly rate + currency already live on `Machine.hourly_rate` /
`hourly_rate_currency`. Retention: `job_order_runs` + `machine_stops` are low-volume
plain tables, kept ≥10 years (no auto-purge).

## Tests

`backend/tests/test_job_order_scan.py` — 8 cases, container harness (rolled back):
open, re-scan no-op, new-OF-closes-previous, production attribution, no-OF no-op,
clear, OF-moves-machines keeps one open run, and same-number-distinct-OF-per-plant.

`backend/tests/test_job_order_cost.py` — 5 cases: no-stops full time, stop excluded
from cost, partial-overlap stop clipped, by-machine/department buckets, cost-report
factory total.

## Phases

1. ✅ **Data foundation + scan wiring** — this doc.
2. ✅ **Cost per OF** — productive time (presence − stops) × `machine.hourly_rate`;
   `GET /{id}/cost` (detail) + `GET /cost-report` (per-OF + factory total).
3. ✅ **OF page** — `/job-orders` list (filters status/department/number, factory cost
   total) + `/job-orders/:id` detail (runs timeline, per-machine/department cost, stats).
   Resource `job_orders` (view: supervisor/MD/PM/director; cost figures gate on `costs`);
   i18n en/fr/es. Files: `pages/JobOrders/{JobOrderList,JobOrderDetail}.tsx` + the 5
   permission files. NOTE: expanding the `JobOrderSource` enum did NOT widen the existing
   `job_orders.source` VARCHAR(6) column → added `ALTER … TYPE VARCHAR(20)` for both
   source columns (a native_enum=False column keeps its original length).
4. ✅ **3D map** — `MapProp` gained `machine_id` + `role` (input/output). In edit mode a
   conveyor gets a machine picker + In/Out toggle; in view mode clicking a conveyor tied
   to a machine opens a side panel listing that machine's OFs (each links to the OF detail).
   Files: `MapProp` model + DDL, `factory_map.py` (PropCreate/PropUpdate/_prop_dict),
   `factoryMap.ts` types, `FactoryMap.tsx` (machineOptions, setPropMachine/Role, ofPanel),
   i18n `factoryMap.of*`/`role_*`.
5. ✅ **External integrations (skeletons)** — `POST /api/machines/{ref}/cortex-scan` and
   `POST /api/machines/{ref}/smart-label`, both funnelling through
   `scan_job_order_at_machine` (source cortex / smart_label). PROVISIONAL per-machine
   `X-Signal-Token` auth (mirrors ADAM `/production-signal`); the real Cortex API /
   label-printer contract is wired with the integrator — no external system connected
   yet. Payload `OfScanIn` {job_number, product_name?, target_quantity?, program?, ts?};
   `product_name`/`target_quantity` enrich the OF (backfill-only), `program` (Cortex cobot
   program) is recorded/echoed, never executed. Enrichment lives in
   `_lookup_or_create`/`scan_job_order_at_machine`.

## Open questions

- Attribute stops/rejects downtime cost per OF (from `MachineStop.job_number`)? — i.e.
  in the Phase 2 report, also show the minutes/$ each OF lost to stoppages while it was
  loaded. Data is already captured; it's a reporting choice.
- Traceability/genealogy (lot/serial, material consumed) — the 10-year retention hints
  at a regulatory driver.
- Cross-plant OF flow: Mirabel supplies St-Jérôme/Las Vegas. For now each plant's OF is
  an independent row; a future "linked OF across plants" (supplier → customer) is out of
  scope.
