# Predictive Intelligence — Architecture & Implementation Plan

> Deliverable required before implementation (2026-07-22). Covers the 18 mandatory
> items: current-architecture diagnosis, data inventory/gaps/quality, recommended
> architecture, data flow, modelling strategy, DB schema, APIs, frontend/backend
> changes, risks, test plan, deployment plan, success criteria, rollback plan.

---

## 1. Diagnosis of the current architecture

| Layer | What exists | Predictive relevance |
|---|---|---|
| Time-series store | TimescaleDB; `sensor_readings` is a hypertable (7-day chunks, compression @30d, retention 2y), `machine_production_hourly` hypertable + `machine_production_daily` continuous aggregate | **Sufficient.** No complementary TSDB needed at current or 10× projected volume. |
| Sensor ingestion | Sushi (Yokogawa LoRaWAN) → `/api/sushi/uplink` with decoding, per-reading `quality`, threshold alerts with **dead-band hysteresis + 24h latch**; legacy MQTT worker; ADAM Modbus gateway (production signals) | Reuse as-is. The hysteresis/latch pattern in `sushi_service` is the model for predictive alert de-noising. |
| Failure records | `work_orders` (type=corrective, `failure_code`, `component`, `root_cause`) — 5,610 rows back to 2023; `maintenance_tickets` (40), `machine_interventions` (45), `machine_stops` (834/month, categorized, `triggers_maintenance` flag) | Rich labels, but scattered across 4 tables with no unified "failure event" concept → must be consolidated (new `failure_events` read-model). |
| KPIs | `kpis.py`: MTBF (corrective WOs over operating time), MTTR, OEE (TPM planned-time basis) | MTBF logic reused as one score signal. |
| Existing "AI risk" | `machine_risk_scores` (Mirai cron): ticket-recency heuristic, no sensors, no baseline, no explanation, no feedback | Kept untouched (different purpose: management insights). The predictive layer is a separate, auditable system. |
| Scheduling | In-process asyncio crons in FastAPI lifespan (`_escalation_loop`, `_pm_loop`, …) — no Celery worker running | Predictive engine follows the same pattern (`_predictive_loop`). |
| Multi-plant | `plant_scope.py` (`plant_scoped`, `ensure_same_plant`, `path_plant_guard`), fail-closed NULLs, 404-not-403 | All new tables carry `plant_id`; all routes scoped. |
| Permissions | `resource:action`, 5 registration points (authStore, permissions.py, Sidebar, App.tsx, UserDetail) | New resource `predictive`. |
| Notifications | Teams (Workflows webhook, real), SMS (Twilio, real), notification_logs audit | Reused for predictive alerts in `active` mode only. |
| i18n | en/fr/es mandatory; backend error codes mapped by frontend | Alert **reasons are stored as structured codes + params**, translated client-side. |

## 2. Data inventory (live DB, 2026-07-22)

| Data | Volume | Span | Quality notes |
|---|---|---|---|
| `sensor_readings` | 7,948 | 13 days | 11 Sushi devices (10 = demo fleet on IMA 5), 32 sensors, per-reading quality flag. **Short history.** |
| Corrective WOs | 5,610 | 3 years | Imported history; `failure_code`/`component` sparsely filled on old rows. |
| `machine_stops` | 834 | 30 days | Categorized; microstops derivable by duration. |
| `machine_production_hourly` | 48 | sparse | ADAM feed not yet streaming continuously (bench moved to IMA 5, IT pending). |
| Tickets / interventions | 40 / 45 | 30 days | Recent, well-structured. |
| Sensor alerts | 7 | 6 days | Threshold alerts working. |

## 3. Data gaps

1. **No unified failure event** — corrective WOs, tickets, interventions and stops overlap; nothing marks *confirmed breakdown vs suspicion vs inspection finding*. → `failure_events` table + sync service + manual confirm/label UI.
2. **No operating-context signal joined to readings** — vibration at production vs idle is not distinguished. → baseline contexts derived from production-hour counts + machine status history (MVP: `run`/`idle`).
3. **Sensor history too short for any supervised learning** — 13 days. Weeks/months must accumulate; the design captures pre-failure fingerprints *from day one* so data builds automatically.
4. **Production feed intermittent** — cycle-time features degrade gracefully (feature reports `insufficient_data`, weight redistributed).
5. **No sensor-fault detection** beyond staleness — frozen values / spikes / gaps must not become machine alerts. → data-quality checks in the engine.

## 4. Data-quality assessment

- Sushi path already stamps `quality` (`ok|error|estimated`) from the sensor's own Data_Status — trustworthy.
- Timestamps: uplink path prefers network-server time; UTC end-to-end. OK.
- Duplicates: ingest is idempotent per uplink. OK.
- Main risk: **device staleness** (battery/LoRa) — `device_health()` already classifies stale/offline; the engine treats non-`ok` device health as reduced data quality, never as machine degradation.

## 5. Recommended architecture

**Everything in the existing backend + TimescaleDB. No new service, no new datastore, no ML framework in the MVP.** Justification: the bottleneck is *labeled sensor history*, not compute; a separate ML service would be maintenance surface with nothing to train on. The design leaves a clean seam (feature vectors + failure labels persisted) for a phase-3 model worker.

### Layered scoring engine (all layers explainable)

| Layer | Technique | Status |
|---|---|---|
| L0 Rules | Existing device thresholds (ISO 10816 zones) + configurable `predictive_rules` (metric, window, condition, threshold, persistence) | MVP |
| L1 Baseline anomaly | Per equipment × metric × operating-context robust baseline (median/MAD + mean/σ, p05/p95); z-score of the current window | MVP |
| L2 Trend | Least-squares slope over 6h/24h windows on bucketed series, normalized by baseline σ | MVP |
| L3 Operational | Microstop count & stop-minutes vs trailing norm; production-rate drop; alarm count | MVP |
| L4 Reliability | % of expected MTBF consumed, MTBF trend, failure recency (from `failure_events`) | MVP |
| L5 Pattern similarity | Feature vector of the current window vs stored pre-failure fingerprints (normalized distance, "similar to N of last M failures"). Graduated confidence: one reference failure carries half weight, two or more full. Backtests only see fingerprints of failures BEFORE the replayed instant (no temporal leakage). | MVP, activates automatically from the first captured fingerprint |
| L6 Supervised models | Classification / TTF regression, temporal validation | **Phase 3 — not built now** (insufficient sensor history; building it today would be AI theatre) |

Approaches evaluated and deferred: sequence mining (needs many failure instances), unsupervised outlier models (z-scores already cover the low-dimension case, isolation forests add opacity), global models with per-asset personalization (needs fleet-scale data). Family-level *peer comparison* is used only as a cold-start fallback for baseline sanity bounds.

### Score & levels

`score = Σ weight_i × factor_i × quality_i`, clamped 0–100, multiplied by a criticality factor. Weights, level cut-offs (normal / watch / alert / critical), windows, persistence, cooldown are **all DB-configured** (`predictive_settings` per plant + per-machine overrides) — no code change to tune. Every evaluation persists a `predictive_health_snapshots` row with the full factor breakdown (auditable trail + trend chart).

### Alert lifecycle & false-positive controls

- Persistence: level must hold for N consecutive evaluations before an alert opens.
- Hysteresis: closes only below `level_threshold − dead_band`.
- Cooldown per (equipment, alert kind).
- Suppression: machine under maintenance/intervention, open predictive alert of same kind, sensor data-quality below floor, module in `silent` mode.
- Confidence: composed from data quality × sample sufficiency × factor agreement; alerts below a floor are recorded but not raised.
- Statuses: `new → in_review → inspection_planned → intervention_required → intervention_done | false_positive | monitoring | closed`.
- Technician feedback (`predictive_alert_feedback`) never mutates the model directly — it is stored, versioned, and only changes behaviour through explicit settings/baseline updates.

### Activation ladder (per plant AND per machine)

`off → silent (record only) → admin (visible to supervisors+) → active (alerts + notifications) [→ ticket integration, config-gated]`. Backtesting endpoint replays history through the same engine before any activation.

### Maturity states (small-data honesty)

`no_data → collecting → baseline_building → rules_monitoring → anomaly_active → (phase 3: model_validating → model_active)` — computed from sample counts and surfaced on every UI.

## 6. Data-flow diagram

```
Sushi/MQTT/ADAM ─▶ ingest (existing) ─▶ sensor_readings (hypertable)
                                            │
              ┌─────────────────────────────┼──────────────────────────┐
              ▼                             ▼                          ▼
   _predictive_loop (15 min)      baseline refresh (daily)    failure sync (hourly)
   quality checks → features      robust stats per context    WOs/tickets/stops
   L0–L5 factors → score          guarded update (no          → failure_events
              │                   degradation learn-in)       → fingerprints (pre-
              ▼                             │                    failure windows)
   predictive_health_snapshots ◀────────────┘                          │
              │ level change + persistence + cooldown                  │
              ▼                                                        ▼
   predictive_alerts ──(mode=active)──▶ Teams/notification_logs   L5 similarity
              │
              ▼
   feedback / status workflow / ticket link (UI)
```

## 7. Database schema (all new tables — zero ALTERs on existing ones)

| Table | Purpose |
|---|---|
| `predictive_settings` | One row per plant: enabled, mode, eval/baseline intervals, weights JSON, level thresholds, persistence, cooldown, windows, confidence floor. |
| `predictive_machine_settings` | Per-equipment override: enabled/mode/threshold deltas. |
| `machine_baselines` | equipment × metric × context: n, mean, std, median, mad, p05/p95, window, version, computed_at, valid. |
| `predictive_health_snapshots` | Audit + trend: ts, score, level, factors JSON, data_quality JSON, mtbf_pct, confidence, engine_version, config_version. |
| `predictive_alerts` | Full alert record: level, score, probable kind/component, reasons JSON (codes+params), sensors involved, observed/expected values, window, confidence, recommendation code, status, assignee, inspection fields, ticket/WO links, silent flag, versions. |
| `predictive_alert_feedback` | Technician verdict: correct?, problem found, component, failure mode, cause, timing, action, part replaced, prevented?, back to normal?, notes. |
| `predictive_rules` | Configurable rules (plant or equipment scope): metric, aggregation, window, operator, threshold, persistence, severity, enabled. |
| `failure_events` | Unified failure read-model: source (wo/ticket/stop/manual) + source_id (unique), started/ended, type, component, confirmed flag, severity. |
| `failure_patterns` | Pre-failure fingerprint per failure_event × window: features JSON. |
| `predictive_config_log` | Append-only JSON snapshot on every settings/rules change (who/when/what) → config_version stamped on snapshots & alerts, rollback-able. |

Volume: snapshots ≈ 50 equip × 96/day ≈ 5k rows/day → plain indexed table (no hypertable needed); note a retention job at phase 2.

## 8. New APIs (`/api/predictive`, all plant-scoped, resource `predictive`)

```
GET  /overview                 dashboard: ranked machines, KPI cards, filters
GET  /machines/{equipment_id}  health detail: score trend, factors, baselines, maturity
GET  /alerts (+filters)        list, GET /alerts/{id} detail
PATCH /alerts/{id}/status      workflow transition (+assignee, inspection date, result)
POST /alerts/{id}/feedback     technician feedback
POST /alerts/{id}/ticket       create inspection ticket (explicit action, never automatic)
GET/PUT /settings              plant + per-machine settings (predictive:update)
GET/POST/PATCH/DELETE /rules   configurable rules (predictive:update)
POST /backtest                 replay a period; report would-be alerts vs real failures,
                               lead times, FP count
GET  /failures + POST /failures/{id}/confirm   label/confirm failure events
```

## 9–12. Frontend / backend changes

- **Backend**: `services/predictive/` (quality, features, baseline, mtbf, engine, backtest, failure_sync) + `routes/predictive.py` + `_predictive_loop` cron + models. No changes to existing services beyond router registration.
- **Frontend**: new page `/predictive` (dashboard: risk ranking, alerts + workflow + feedback modal, settings for supervisors); new **Santé prédictive tab** on `EquipmentDetail` (score gauge, factor list, trend chart with baseline band, MTBF %, alerts, feedback); factory-map machine summary gains the health level (payload field only — no new 3D geometry, no per-frame work → no map-perf impact). All strings i18n en/fr/es; alert reasons rendered from codes.

## 13. Technical risks

| Risk | Mitigation |
|---|---|
| Short sensor history → weak baselines | Maturity states; min-sample floors; peer bounds; confidence discounts; silent mode default. |
| Baseline learns degradation as normal | Refresh excludes pre-failure horizons, maintenance windows, non-ok quality; drift cap freezes baseline + flags for review. |
| Sensor faults → false machine alerts | Frozen/spike/gap/impossible checks run first; sensor-fault finding suppresses machine-level factors. |
| Alert fatigue | Persistence + hysteresis + cooldown + grouping + confidence floor; silent-first rollout. |
| Cron blocking the API loop | Same budget discipline as existing crons: batched queries, per-equipment try/except, bounded work per tick. |
| create_all/migration conflicts | New tables only; additive; startup DDL follows the guarded idempotent pattern. |

## 14. Operational risks

False negatives (missed failures) are communicated honestly: the UI never claims coverage — maturity + confidence are always displayed. Recommendations use suggestive language ("inspection recommended", "increased risk"), never certainty. Technicians' feedback loop is the recall mechanism.

## 15. Test plan

`tests/test_predictive.py` (same rollback harness as `test_sushi.py`): quality checks (frozen/spike/stale/gap), baseline build + context split + exclusion windows + drift guard, feature extraction (slope, microstops, MTBF %), score composition + level mapping, persistence/hysteresis/cooldown, suppression (maintenance, sensor fault), alert lifecycle + feedback, failure sync idempotency, fingerprint capture + similarity, backtest replay determinism, plant scoping (cross-plant 404/isolation), settings/rules validation. Frontend: `tsc --noEmit` clean. Simulated scenarios via `scripts/simulate_predictive.py` (gradual vibration ramp → failure, hot-but-healthy, frozen sensor, machine in maintenance, MTBF-consumed + degrading sensors, insufficient data).

## 16. Deployment plan

1. Merge additive schema (auto via create_all + guarded DDL on boot).
2. Backend rebuild; module defaults **off** for every plant.
3. Enable `silent` on QS; run ≥1–2 weeks; review backtest + snapshot history.
4. `admin` visibility → tune weights/thresholds from real snapshots.
5. `active` per machine (start with IMA 5 fleet); Teams notifications on.
6. Ticket integration last, per-plant config approval required.

## 17. Success criteria

Sensors recorded correctly · failures linked to machines · pre-failure windows analyzable · context-aware baseline live · explainable alerts (codes + observed/expected + confidence) · MTBF integrated in score · feedback recorded · multi-site isolation preserved · silent/backtest modes working · tests green, zero regression · module and thresholds configurable per plant/machine without code · full alert traceability (engine_version + config_version on every artifact).

## 18. Rollback plan

The module is additive and flag-gated: set mode `off` (per plant or globally) → engine skips, UI hides data, zero writes. Full rollback = revert commit; new tables are ignored by the old code and can be dropped later (`DROP TABLE predictive_* , machine_baselines, failure_events, failure_patterns`). Config changes roll back via `predictive_config_log` snapshots. No existing table is altered, so downgrade is risk-free.
