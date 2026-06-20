# Robot Cell Telemetry — Ingestion Contract (v1, provisional)

Read-only telemetry from FANUC CRX cells into the MES. The MES **receives, stores
and displays** cell data. It **never** commands motion, safety, reset, gate or
E‑stop — there is no field or endpoint for that, by design.

Each cell maps to an **existing Equipment** in the MES (we do not create new
equipment). A cell is identified by its `equipment_id`.

> Status: transport and authentication are **provisional** (HTTP + per‑cell token)
> pending review with the integrator. The payload below is the stable contract;
> the same payload can be delivered over MQTT/OPC UA later without changing it.

## Endpoint (provisional)

```
POST /api/robot-cells/{equipment_id}/telemetry
Header: X-Cell-Token: <per-cell secret>
Content-Type: application/json
Body: a JSON object with any subset of the fields below (partial updates merge)
→ 200 {"ok": true}   |   401 invalid token   |   404 cell not configured
```

Send a frame on change and/or on a fixed interval (e.g. every 1–5 s). Only include
the fields the cell actually knows; omitted fields keep their last value.

## Fields

| Field | Type | Values / notes |
|---|---|---|
| `online` | bool | cell reachable |
| `run_state` | string | `running` \| `stopped` \| `fault` \| `idle` — **drives the factory map / 3D twin** |
| `op_mode` | string | `auto` \| `manual` |
| `servo_on` | bool | |
| `robot_ready` | bool | |
| `alarm_active` | bool | when it goes false, open alarms are cleared |
| `alarm_code` | string | e.g. `SRVO-050` |
| `alarm_message` | string | human-readable |
| `current_program` | string | |
| `current_recipe` | string | |
| `current_wo` | string | current work order |
| `current_sku` | string | |
| `cycle_running` | bool | |
| `cycle_complete` | bool | |
| `last_cycle_s` | number | seconds |
| `avg_cycle_s` | number | seconds |
| `good_count` | int | |
| `reject_count` | int | |
| `total_count` | int | |
| `safety_ok` | bool | mirror only (read-only) |
| `estop_active` | bool | mirror only |
| `scanner_zone` | string | `clear` \| `occupied` |
| `collaborative_mode` | bool | |
| `reduced_speed` | bool | |
| `stopped_by_safety` | bool | |
| `gate_state` | string | `open` \| `closed` \| `moving` \| `fault` |
| `reset_required` | bool | |
| `robot_running_hours` | number | |
| `servo_hours` | number | |
| `cycle_count` | int | |
| `fault_count` | int | |
| `availability` | number | percent |
| `mtbf` | number | hours |
| `mttr` | number | hours |

## Example

```bash
curl -X POST https://<host>/api/robot-cells/<equipment_id>/telemetry \
  -H "X-Cell-Token: <secret>" -H "Content-Type: application/json" \
  -d '{
    "online": true, "run_state": "running", "op_mode": "auto",
    "servo_on": true, "robot_ready": true, "alarm_active": false,
    "current_program": "PALLET_PICK", "current_wo": "WO-2026-1234",
    "cycle_running": true, "last_cycle_s": 31.2, "good_count": 258,
    "reject_count": 14, "total_count": 272, "safety_ok": true,
    "scanner_zone": "clear", "gate_state": "closed",
    "robot_running_hours": 1840.5, "availability": 94.9, "mtbf": 210.3, "mttr": 0.8
  }'
```

## What the MES does with it
- Upserts a **live snapshot** (cell page).
- Appends a **history sample** (trends, availability over time).
- Opens/closes an **alarm log** entry on `alarm_active`.
- Mirrors `run_state` to the **factory map / 3D twin** (cobot block colour + animation).

## Open questions for the integrator
1. **Transport**: HTTP POST (above), MQTT topic, or OPC UA polling? (Same payload either way.)
2. **Auth**: per-cell token (header), mTLS, MQTT broker creds, or other?
3. **Cell identity**: confirm we key by MES `equipment_id` (we can also accept a cell `code`/IP and map it).
4. **Cadence**: on-change, fixed interval, or both? Expected frequency.
