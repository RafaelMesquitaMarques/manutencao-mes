# Shift Replay (Factory Map) — architecture and limits

> Delivered on 2026-09-17. An extra Factory Map mode that plays back on the map
> what happened during a past shift or period. **Zero new tables, zero new
> columns, zero new rows** — it is a pure read of the history the platform
> already records.

---

## 1. Why there is no new model

The request was to replay machine states, OFs moving through the machines and
relevant events. Before proposing any new recording, here is the inventory of
what already exists:

| Replay signal | Table that already stores it | Coverage |
|---|---|---|
| Stops with justification | `machine_stops` (`started_at`/`ended_at`, category, subcategory, comment, operator) | Complete |
| Maintenance intervention (purple) | `machine_interventions` (`started_at`/`completed_at`) + `intervention_technicians` (check-in/out) | Complete |
| Open ticket (amber) | `maintenance_tickets` (`opened_at`, `completed_at`, `closed_by_technician_at`) | Complete |
| OF per equipment over time | `job_order_runs` — the runs ledger, one row per scan | Complete |
| Actual production | `machine_production_hourly` (actual hour, count, rejects, OF) | Hourly |
| Pit Stop buffer | `pit_stop_movements` (append-only, in/out with timestamp) | At OF level |
| Alerts / rejects | `maintenance_alerts.created_at`, `reject_logs.created_at` | Complete |
| Shifts | `machines.shifts_config` (plant wall-clock time) | Complete |

`job_order_runs` was designed as history ("one row per scan — low volume, kept
≥10 years") and is exactly what the replay needs for the OFs. For the states,
what is missing is a log of `machines.current_status` — but the live state is
already *derived* from the same three sources above
(`app/services/live_status.py`), so deriving it in the past uses the same rules
instead of introducing a second truth.

Conclusion: **duplicating state in a replay log would mean storing what can
already be rebuilt.** The replay's storage cost is zero.

## 2. State precedence

At each instant, the highest-priority layer covering that moment wins the color
(`app/services/factory_replay.py::_resolve_segments`):

| Priority | Layer | State |
|---|---|---|
| 3 | Active intervention | `intervention` (purple) |
| 2 | Open stop | `maintenance` / `planned_stop` / `stopped` / `unjustified`, depending on the category type |
| 1 | Open maintenance ticket | `maintenance` (amber) |
| 0 | Nothing recorded | `running` (green) |

This mirrors `live_status.effective_status` + what the stop endpoints write to
`machines.current_status`. Each segment carries a `source`
(`stop`/`intervention`/`ticket`/`baseline`/`no_history`) and the UI shows that
provenance, so that "green because no event was recorded" is never mistaken for
"measured green".

Ticket intervals travel separately (`ticket_spans`): the amber badge stays
exact even when a red stop wins the block's color.

## 3. API shape

```
GET /api/factory-replay/{plant_id}/windows?date=YYYY-MM-DD
    → shifts the plant runs on that local day (aggregated from shifts_config)
      + the whole-day window

GET /api/factory-replay/{plant_id}/timeline?start=ISO&end=ISO
    → { tracks[], of_runs[], pit_events[], pit_moved_before[],
        production[], events[] }
```

Everything is keyed by `equipment_id` — the same id `MapMachine.id` already
uses — so the frontend reuses geometry, colors, filters, zones and views without
any mapping.

The whole window arrives in **a single fetch** (intervals, not samples), so
playing, pausing, speeding up and jumping are local operations, with no network
traffic. Maximum window 24 h; `end` is clipped at "now" (the future has no
history).

Access: `factory_map:view` + belonging to the plant — whoever can see the plant
live can review it.

## 4. Map integration

`ReplayIndex.overlayAt(t)` returns **exactly the same shape** that the live
WebSocket push delivers to `applyStatus()`. Turning the replay on swaps the
source, not the renderer: 2D (React Flow), 3D (Three.js), the legend with
counts, the queue badges on the conveyors and the technician pictograms work
unchanged.

While the replay is active, these are **suspended**: the state WS, the 30 s
fallback poll, the Pit Stop poll, the OF "spots" poll, the weather, the
temperature readings and the 30-day live KPIs. Leaving the replay reloads the
map and turns everything back on. Edit mode is unavailable during the replay.

## 5. Limitations (accepted, not filled in with invented data)

1. **No `current_status` log.** The state is rebuilt. A machine with no recorded
   event at all shows green — as it would live, too.
2. **The pink `unjustified` rarely reappears.** The stop category is recorded at
   justification time, often after the fact; the history keeps only the final
   value, so the stop shows as already justified from its very start.
3. **Cobot telemetry is not historized** (`robot_cell_states` is current state).
   In the replay, conveyors and cobots fully follow their parent machine.
4. **Operator over time is partial** — it comes from `job_order_runs.operator_id`
   and `machine_stops.operator_id`; the kiosk does not historize
   `current_operator`.
5. **The planned queue (`pipeline_ofs`) and the line scoreboards (`line_stats`)
   cannot be historized** — they are hidden in the replay instead of showing a
   live value.
6. **Pit Stop 3D stacks are not rebuilt** in this delivery: the buffer renders
   empty and the ins/outs show up in the OF's trail. The ledger makes it possible
   to rebuild them later (balance per component up to T) — see §6.
7. **Ambient temperature and weather** are not rebuilt on the map
   (`sensor_readings` has history, but the map's thermometers show the current
   state); they show no reading in the replay.
8. **The parked queue at the machines** counts the OFs whose last run happened
   in the window or in the previous 72 h (`CARRY_IN_HOURS`); OFs that have been
   idle for longer are not carried into the window.

## 6. Possible next steps

- Rebuild the Pit Stop stacks per instant (balance per component =
  Σ in − Σ out up to T, already supported by the ledger) and feed `pitStop` in
  the 3D view.
- Replay the temperature readings from `sensor_readings` (a hypertable that
  already holds the history).
- Export a summary of the replayed shift (stops by cause, completed OFs) for the
  production meeting.

## 7. Files

| Path | Role |
|---|---|
| `backend/app/services/factory_replay.py` | Reconstruction (interval algebra + reads) |
| `backend/app/api/routes/factory_replay.py` | `/api/factory-replay` (2 endpoints, GET only) |
| `backend/tests/test_factory_replay.py` | Precedence, clipping, shift windows, assembly |
| `frontend/src/api/factoryReplay.ts` | Client + types |
| `frontend/src/pages/FactoryMap/replay/replayModel.ts` | In-memory index + `overlayAt(t)` |
| `frontend/src/pages/FactoryMap/replay/useReplay.ts` | Playback clock |
| `frontend/src/pages/FactoryMap/replay/ReplayBar.tsx` | Transport bar + timeline |
| `frontend/src/pages/FactoryMap/replay/ReplayMachineDetail.tsx` | Machine at the instant |
| `frontend/src/pages/FactoryMap/replay/ReplayOfDetail.tsx` | OF path |
| `frontend/src/pages/FactoryMap/replay/replayModel.test.ts` | State, inheritance, queues, buffer |
