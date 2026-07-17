# Pit Stop ↔ SAP — assumed integration contract

> **Status: ASSUMPTION.** No SAP-side specification exists yet (2026-07). This
> document freezes what KAIZO implements today so the SAP/HANA team can either
> conform to it or hand us their real format — every assumption below is
> isolated in one adapter surface and cheap to change. Same approach as the
> Cortex poller's assumed `_fetch_scans` contract.

## What SAP is the source of truth for

| Data | KAIZO storage | Notes |
|---|---|---|
| Scan of components/lots **entering** the Pit Stop | `pit_stop_movements` (direction `in`) | one event per scan |
| **Exit** movement toward an assembly line | `pit_stop_movements` (direction `out`) | the SAP transfer movement |
| Storage **position** of each lot | `pit_stop_movements.position_code` | free text — real format TBD |
| **BOM** — components + quantities expected per OF | `job_order_components` | needed for completeness/OTIF |
| **Destination line** of the OF | `pit_stop_of_states.destination_machine_id` | resolved from the payload `destination` |

Until the integration exists, `scripts/simulate_pit_stop.py` feeds the same
tables with `source='simulated'` (wipe with `--reset`).

## Transport (assumed): HTTP push into KAIZO

```
POST /api/pit-stop/{plant_id}/ingest
X-Signal-Token: <token>          # provisioned per plant by scripts/seed_pit_stop.py
Content-Type: application/json

{
  "job_number":     "1234567",         // OF number as printed on the label
  "component_code": "PAN-00123",       // SAP material/component code
  "direction":      "in",              // "in" = entering the buffer, "out" = leaving to a line
  "quantity":       24,
  "position_code":  "L07-P03",         // SAP/HANA storage bin — free text, see below
  "destination":    "ASM-L2",          // on "out": KAIZO machine id, code or kiosk slug
  "occurred_at":    "2026-07-13T14:02:11-04:00"   // scan instant; omitted → server time
}
```

Response `201`: `{"movement_id", "job_order_id", "direction", "quantity", "anomaly"}`.

If SAP can only be **polled** (HANA view / OData / IDoc file drop), the push
endpoint stays the internal sink and a poller worker (same pattern as
`app/workers/cortex_poller.py`, with a persisted cursor) translates — the
tables and the read model don't change.

## Semantics KAIZO applies

- **Never rejects a plausible event.** Anomalies are recorded WITH the movement
  in `anomaly`: `unknown_of` (OF created on the fly), `unknown_component` (not
  in the BOM), `duplicate` (identical event already stored), `negative_balance`
  (out > on-hand). HTTP 4xx only for malformed payloads (missing fields, bad
  direction) or a bad token.
- **On-hand** per (OF, component) = Σ in − Σ out. An OF is *in* the buffer
  while its total on-hand > 0.
- **Completeness** compares CUMULATIVE received (Σ in) against
  `job_order_components.required_qty` — leaving to the line does not make an OF
  incomplete again. Aligned with the client's OAV report (`DispoPit%`,
  PDPAssemblageQS, verified 2026-07-16): availability per component CATEGORY =
  Σ min(received, required) / Σ required inside the group, and the OF's % is the
  **MINIMUM across categories** (weakest link), with carton/box categories
  excluded from the min (packaging never gates assembly availability).
  `in full` = every BOM line satisfied, carton included (drives the release
  confirmation). OTIF bands: 100 % and STRICTLY > 90 % (cumulative); EU are
  availability-weighted (× %, their `UEdispo`); OFs older than
  `repair_after_days` (default 2) leave the bands and the denominator
  ("EU en attente de réparation"), and OTIF % = band CG EU ÷ that net total.
  The TV board mirrors the client's Feuil1 table (EU total / EU pit / Dispo sur
  ligne / Assigné non disponible / Attente quincaillerie / bands / réparation;
  "assigned to a line" maps to our released state in v1).
- **Idempotency**: an exactly identical event (same OF, component, direction,
  quantity, position, `occurred_at`) is stored but flagged `duplicate`. If SAP
  can send a unique event id, we will use it as the idempotency key instead —
  **please provide one if possible.**

## Position code (`position_code`) — biggest open point

Assumed format until the real HANA bin addressing is known:

```
L{lane:02d}-P{slot:02d}      e.g. "L07-P03"  → lane 7, slot 3
```

- Lanes are the 41 conveyors (44 ft) numbered from the fabrication side.
- Codes that DON'T match the format are still accepted and displayed; the 3D
  map shows those OFs in an "unassigned" strip instead of on a lane.
- When the real format arrives, only `pit_stop_service.parse_position` changes.

## BOM (`job_order_components`) — needed before go-live

The completeness engine needs, per OF: component code, description, expected
quantity, and (ideally) a component **category** for the map colouring
(`pit_stop_categories` registry). Assumed delivery: pushed with the first scan
or a nightly sync — format TBD with the SAP team.

## Open questions for the SAP team

1. Push (webhook/middleware) or pull (HANA view / OData / file)? Frequency?
2. Real storage-bin format for `position_code`?
3. Unique event id for idempotency?
4. Where does the BOM per OF come from (CS03/MAST extract? custom view?) and
   how do component codes map to categories?
5. Which SAP movement types map to `in` and `out` (e.g. 311/261…)?
6. How is the **destination line** encoded (work center → KAIZO machine code)?
