"""Shift replay — rebuilding the factory's past from what is ALREADY recorded.

No new table, column or row: everything here is a read. A machine's state at
instant T is *derived* with the SAME precedence as live mode
(`app/services/live_status.py`), and the OFs come from the runs ledger
(`job_order_runs`), which is already the complete history of where each OF went.

State precedence (mirrors live mode):

    1. active intervention (technician at the machine)    → intervention  (purple)
    2. open stop                                          → maintenance / planned_stop /
                                                            stopped / unjustified
    3. open maintenance ticket                            → maintenance   (amber)
    4. nothing recorded                                   → running       (green)

Step 4 is the same behavior as live mode (`machines.current_status` starts as
`running` and goes back to `running` when the stop closes), so it is faithful — but
it is an *inference from the absence of events*, and each segment carries `source`
so the UI can say where it came from.

Known limitations (documented, never filled in with made-up data):
  • there is no log of `machines.current_status`; the pink `unjustified` rarely
    reappears because the stop category is recorded on justification (often
    later) and the history keeps only the final value;
  • cobot telemetry (`robot_cell_states`) is current state only → in the replay the
    children follow the parent machine entirely (resolved in the frontend, same
    parent–child rule as live mode);
  • operator over time is partial (runs/stops carry it, the kiosk does not keep a
    history of `current_operator`).
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional, Sequence
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Equipment, InterventionTechnician, JobOrder, JobOrderRun, Machine,
    MachineIntervention, MachineOperator, MachineProductionHourly, MachineStop,
    MaintenanceAlert, MaintenanceTicket, PitStopMovement, Plant, RejectCategory,
    RejectLog, RejectSubcategory, StopCategory, StopCategoryType,
    StopSubcategory, TicketStatus,
)

# Maximum window of a replay. A shift is 8 h; 24 h covers "the whole day" and
# keeps the payload in a range the client builds in one go and navigates offline.
MAX_WINDOW_HOURS = 24
DEFAULT_TZ = "America/Toronto"

# Ticket statuses that still count as open (amber on the map). Same vocabulary
# as live_status.OPEN_TICKET_STATUSES.
_OPEN_TICKET_STATUSES = [
    TicketStatus.open, TicketStatus.in_progress,
    TicketStatus.on_hold_parts, TicketStatus.on_hold_ext,
]

# Layer priority when resolving the state at an instant (higher wins).
_P_BASELINE = 0
_P_TICKET = 1
_P_STOP = 2
_P_INTERVENTION = 3

# Stop category type → map state. No category = unjustified stop (pink),
# exactly as `machines.py::open_stop` decides in live mode.
_STOP_TYPE_STATUS = {
    StopCategoryType.maintenance: "maintenance",
    StopCategoryType.planned: "planned_stop",
    StopCategoryType.unplanned: "stopped",
}


def tz_of(name: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    d = as_utc(dt)
    return d.isoformat() if d else None


# ─── Selectable windows (the day's shifts) ────────────────────────────────────

def _windows_from_config(cfg: Optional[dict], for_date: date, tz: ZoneInfo) -> list[tuple[str, datetime, datetime]]:
    """(key, start_utc, end_utc) per configured shift, for a LOCAL date.

    Same reading as `shift_report_service.keyed_shift_windows`: the HH:MM in
    `shifts_config` are plant wall-clock time; a shift that crosses
    midnight belongs to the day it starts on.
    """
    out: list[tuple[str, datetime, datetime]] = []
    for key, c in (cfg or {}).items():
        if not isinstance(c, dict):
            continue
        try:
            sh, sm = [int(x) for x in str(c.get("start", "")).split(":")[:2]]
            eh, em = [int(x) for x in str(c.get("end", "")).split(":")[:2]]
        except (ValueError, TypeError):
            continue
        start_local = datetime.combine(for_date, time(sh, sm), tzinfo=tz)
        end_local = datetime.combine(for_date, time(eh, em), tzinfo=tz)
        if end_local <= start_local:
            end_local += timedelta(days=1)
        out.append((key, start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)))
    return out


async def shift_windows_for_day(db: AsyncSession, plant_id, for_date: date) -> dict:
    """The plant's selectable shifts on a local day + the whole-day window.

    Aggregates the `shifts_config` of the active machines: identical shifts (same
    key + same hours) become ONE option, with the count of machines that use
    them. Plants without any `shifts_config` get only the "whole day" option —
    we don't invent default shifts.
    """
    plant = await db.get(Plant, plant_id)
    tz = tz_of(plant.timezone if plant else None)

    rows = (await db.execute(
        select(Machine.shifts_config).where(
            Machine.plant_id == plant_id,
            Machine.is_active == True,  # noqa: E712
            Machine.shifts_config.isnot(None),
        )
    )).scalars().all()

    grouped: dict[tuple[str, str, str], int] = defaultdict(int)
    for cfg in rows:
        for key, ws, we in _windows_from_config(cfg, for_date, tz):
            grouped[(key, ws.isoformat(), we.isoformat())] += 1

    windows = [
        {"key": key, "start": ws, "end": we, "machine_count": n}
        for (key, ws, we), n in sorted(grouped.items(), key=lambda kv: kv[0][1])
    ]

    day_start = datetime.combine(for_date, time(0, 0), tzinfo=tz).astimezone(timezone.utc)
    day_end = day_start + timedelta(days=1)
    return {
        "plant_id": str(plant_id),
        "timezone": plant.timezone if plant else DEFAULT_TZ,
        "date": for_date.isoformat(),
        "windows": windows,
        "day": {"start": day_start.isoformat(), "end": day_end.isoformat()},
    }


# ─── State reconstruction ─────────────────────────────────────────────────────

class _Layer:
    """A candidate interval for painting the machine, with its priority."""
    __slots__ = ("start", "end", "priority", "status", "reason", "source", "ref_id", "detail")

    def __init__(self, start, end, priority, status, reason=None, source=None, ref_id=None, detail=None):
        self.start = start
        self.end = end
        self.priority = priority
        self.status = status
        self.reason = reason
        self.source = source
        self.ref_id = ref_id
        self.detail = detail


def _clip(start: Optional[datetime], end: Optional[datetime],
          w_start: datetime, w_end: datetime) -> Optional[tuple[datetime, datetime]]:
    """Clips [start, end) to the window. Null `end` = still open at the end of the window."""
    s = as_utc(start) or w_start
    e = as_utc(end) or w_end
    s = max(s, w_start)
    e = min(e, w_end)
    return (s, e) if e > s else None


def _resolve_segments(layers: list[_Layer], w_start: datetime, w_end: datetime) -> list[dict]:
    """Boundary sweep: in each sub-interval the highest-priority layer covering
    it wins. Identical adjacent segments are merged."""
    bounds = {w_start, w_end}
    for l in layers:
        bounds.add(l.start)
        bounds.add(l.end)
    points = sorted(b for b in bounds if w_start <= b <= w_end)

    out: list[dict] = []
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        if b <= a:
            continue
        mid = a + (b - a) / 2
        best: Optional[_Layer] = None
        for l in layers:
            if l.start <= mid < l.end and (best is None or l.priority > best.priority):
                best = l
        if best is None:
            continue
        seg = {
            "start": _iso(a), "end": _iso(b),
            "status": best.status, "reason": best.reason,
            "source": best.source, "ref_id": best.ref_id,
            "detail": best.detail,
        }
        prev = out[-1] if out else None
        if (prev and prev["status"] == seg["status"] and prev["reason"] == seg["reason"]
                and prev["source"] == seg["source"] and prev["ref_id"] == seg["ref_id"]
                and prev["end"] == seg["start"]):
            prev["end"] = seg["end"]
        else:
            out.append(seg)
    return out


async def _stop_layers(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> dict[str, list[_Layer]]:
    if not machine_ids:
        return {}
    rows = (await db.execute(
        select(MachineStop, StopCategory.type, StopCategory.name, StopSubcategory.name)
        .outerjoin(StopCategory, StopCategory.id == MachineStop.stop_category_id)
        .outerjoin(StopSubcategory, StopSubcategory.id == MachineStop.stop_subcategory_id)
        .where(
            MachineStop.machine_id.in_(machine_ids),
            MachineStop.started_at < w_end,
            or_(MachineStop.ended_at.is_(None), MachineStop.ended_at > w_start),
        )
    )).all()
    out: dict[str, list[_Layer]] = defaultdict(list)
    for stop, cat_type, cat_name, sub_name in rows:
        span = _clip(stop.started_at, stop.ended_at, w_start, w_end)
        if not span:
            continue
        status = _STOP_TYPE_STATUS.get(cat_type, "unjustified" if cat_type is None else "stopped")
        reason = sub_name or cat_name or (stop.comments or "").strip() or None
        out[str(stop.machine_id)].append(_Layer(
            span[0], span[1], _P_STOP, status,
            reason=(reason[:200] if reason else None), source="stop", ref_id=str(stop.id),
            detail={"comments": (stop.comments or None), "justified_by": stop.justified_by,
                    "job_number": stop.job_number},
        ))
    return out


async def _intervention_layers(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> tuple[dict, dict]:
    """(purple layers per machine, technicians present per intervention)."""
    if not machine_ids:
        return {}, {}
    rows = (await db.execute(
        select(MachineIntervention).where(
            MachineIntervention.machine_id.in_(machine_ids),
            MachineIntervention.started_at.isnot(None),
            MachineIntervention.started_at < w_end,
            or_(MachineIntervention.completed_at.is_(None),
                MachineIntervention.completed_at > w_start),
        )
    )).scalars().all()

    techs: dict[str, list[dict]] = defaultdict(list)
    if rows:
        for iv_id, name, cin, cout in (await db.execute(
            select(InterventionTechnician.intervention_id, InterventionTechnician.name,
                   InterventionTechnician.checked_in_at, InterventionTechnician.checked_out_at)
            .where(InterventionTechnician.intervention_id.in_([r.id for r in rows]))
            .order_by(InterventionTechnician.checked_in_at.asc())
        )).all():
            techs[str(iv_id)].append({
                "name": name, "since": _iso(cin), "until": _iso(cout),
            })

    layers: dict[str, list[_Layer]] = defaultdict(list)
    for iv in rows:
        span = _clip(iv.started_at, iv.completed_at, w_start, w_end)
        if not span:
            continue
        # With no recorded check-ins, the name of whoever started it is the only
        # source — same fallback rule that live_status uses for the pictograms.
        present = techs.get(str(iv.id)) or (
            [{"name": iv.started_by_name, "since": _iso(iv.started_at), "until": _iso(iv.completed_at)}]
            if iv.started_by_name else []
        )
        layers[str(iv.machine_id)].append(_Layer(
            span[0], span[1], _P_INTERVENTION, "intervention",
            reason=iv.intervention_type_name, source="intervention", ref_id=str(iv.id),
            detail={"technicians": present, "ticket_id": str(iv.ticket_id) if iv.ticket_id else None,
                    "called_at": _iso(iv.called_at), "mechanic_note": iv.mechanic_note},
        ))
    return layers, techs


async def _ticket_layers(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> tuple[dict, dict, list[dict]]:
    """(amber layers per machine, ticket intervals per machine, timeline events)."""
    if not machine_ids:
        return {}, {}, []
    rows = (await db.execute(
        select(MaintenanceTicket).where(
            MaintenanceTicket.machine_id.in_(machine_ids),
            MaintenanceTicket.opened_at < w_end,
            or_(
                MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES),
                MaintenanceTicket.completed_at.is_(None),
                MaintenanceTicket.completed_at > w_start,
            ),
        )
    )).scalars().all()
    layers: dict[str, list[_Layer]] = defaultdict(list)
    spans: dict[str, list[dict]] = defaultdict(list)
    events: list[dict] = []
    for t in rows:
        # A ticket still open today stays open until the end of the window; a
        # closed one uses completed_at (or the technician's close, when present).
        closed = t.completed_at or t.closed_by_technician_at
        if t.status not in _OPEN_TICKET_STATUSES and closed is None:
            continue
        span = _clip(t.opened_at, None if t.status in _OPEN_TICKET_STATUSES else closed, w_start, w_end)
        if span:
            layers[str(t.machine_id)].append(_Layer(
                span[0], span[1], _P_TICKET, "maintenance",
                reason=t.description[:200] if t.description else None,
                source="ticket", ref_id=str(t.id),
                detail={"ticket_number": t.ticket_number,
                        "priority": t.priority.value if t.priority else None},
            ))
            spans[str(t.machine_id)].append({
                "start": _iso(span[0]), "end": _iso(span[1]),
                "ticket_id": str(t.id), "ticket_number": t.ticket_number,
            })
        opened = as_utc(t.opened_at)
        if opened and w_start <= opened < w_end:
            events.append({"ts": _iso(opened), "kind": "ticket_opened", "machine_id": str(t.machine_id),
                           "label": t.ticket_number, "ref_id": str(t.id)})
        cl = as_utc(closed)
        if cl and w_start <= cl < w_end:
            events.append({"ts": _iso(cl), "kind": "ticket_closed", "machine_id": str(t.machine_id),
                           "label": t.ticket_number, "ref_id": str(t.id)})
    return layers, spans, events


# ─── OFs, production and events ───────────────────────────────────────────────

# How far before the window we look for an OF's LAST already-closed run. This
# is what rebuilds the queue already parked at the machine outputs when the shift
# starts (the map's +N badges); without it the replay would start with empty queues.
CARRY_IN_HOURS = 72


def _run_row(run, number, product, target, operator, carry_in: bool) -> dict:
    return {
        "id": str(run.id),
        "job_order_id": str(run.job_order_id),
        "job_number": number,
        "product_name": product,
        "target_quantity": target,
        "machine_id": str(run.machine_id),
        "department": run.department,
        "operator": operator,
        "started_at": _iso(run.started_at),
        "ended_at": _iso(run.ended_at),
        "pieces": run.pieces or 0,
        "rejects": run.rejects or 0,
        "last_piece_at": _iso(run.last_piece_at),
        # True = run from before the window, brought in only to know what was already
        # parked at the start. Never counts as "OF at the machine" during the replay.
        "carry_in": carry_in,
    }


async def _of_runs(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> list[dict]:
    """Runs that touch the window + the last closed run of each OF in the
    preceding hours (the parked queue). A run is the historical source of where
    the OF was: `started_at ≤ T < ended_at` = OF at the machine at instant T."""
    if not machine_ids:
        return []
    cols = (JobOrderRun, JobOrder.job_number, JobOrder.product_name,
            JobOrder.target_quantity, MachineOperator.name)
    base = (
        select(*cols)
        .join(JobOrder, JobOrder.id == JobOrderRun.job_order_id)
        .outerjoin(MachineOperator, MachineOperator.id == JobOrderRun.operator_id)
    )
    rows = (await db.execute(
        base.where(
            JobOrderRun.machine_id.in_(machine_ids),
            JobOrderRun.started_at < w_end,
            or_(JobOrderRun.ended_at.is_(None), JobOrderRun.ended_at > w_start),
        ).order_by(JobOrderRun.started_at.asc())
    )).all()
    out = [_run_row(*r, carry_in=False) for r in rows]
    seen_runs = {r["id"] for r in out}

    # Parked queue: per OF, the most recent closed run before the window.
    carry = (await db.execute(
        base.where(
            JobOrderRun.machine_id.in_(machine_ids),
            JobOrderRun.ended_at.isnot(None),
            JobOrderRun.ended_at <= w_start,
            JobOrderRun.ended_at >= w_start - timedelta(hours=CARRY_IN_HOURS),
        )
        .distinct(JobOrderRun.job_order_id)
        .order_by(JobOrderRun.job_order_id, JobOrderRun.ended_at.desc())
    )).all()
    for r in carry:
        row = _run_row(*r, carry_in=True)
        if row["id"] not in seen_runs:
            out.append(row)
    return out


async def _pit_events(db: AsyncSession, plant_id, w_start, w_end) -> list[dict]:
    """Pit Stop buffer ins/outs in the window — aggregated by OF, direction
    and minute, for the OF trace without dumping the whole ledger on the client."""
    rows = (await db.execute(
        select(PitStopMovement.job_order_id, JobOrder.job_number,
               PitStopMovement.direction, PitStopMovement.component_code,
               PitStopMovement.quantity, PitStopMovement.occurred_at,
               PitStopMovement.destination_machine_id)
        .join(JobOrder, JobOrder.id == PitStopMovement.job_order_id)
        .where(PitStopMovement.plant_id == plant_id,
               PitStopMovement.occurred_at >= w_start,
               PitStopMovement.occurred_at < w_end)
        .order_by(PitStopMovement.occurred_at.asc())
    )).all()
    bucket: dict[tuple, dict] = {}
    for of_id, number, direction, component, qty, at, dest in rows:
        at_utc = as_utc(at)
        minute = at_utc.replace(second=0, microsecond=0)
        key = (str(of_id), direction.value if hasattr(direction, "value") else str(direction), minute)
        entry = bucket.get(key)
        if entry is None:
            entry = bucket[key] = {
                "ts": _iso(minute), "job_order_id": str(of_id), "job_number": number,
                "direction": key[1], "quantity": 0, "components": [],
                "destination_machine_id": str(dest) if dest else None,
            }
        entry["quantity"] += qty or 0
        if component and component not in entry["components"] and len(entry["components"]) < 8:
            entry["components"].append(component)
    return sorted(bucket.values(), key=lambda e: e["ts"])


async def _pit_moved_before(db: AsyncSession, plant_id, w_start) -> list[str]:
    """OFs that had already entered the buffer before the window. An OF that
    reached the Pit Stop is no longer parked at the machine output — without this
    the parked queue would count material that had already moved on."""
    rows = (await db.execute(
        select(PitStopMovement.job_order_id)
        .where(PitStopMovement.plant_id == plant_id,
               PitStopMovement.occurred_at < w_start)
        .distinct()
    )).scalars().all()
    return [str(r) for r in rows]


async def _production(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> list[dict]:
    """Real hourly counts (ADAM feed). The hour is truncated in UTC, so the
    window's first hour is included even if the window starts in the middle of it."""
    if not machine_ids:
        return []
    first_hour = w_start.replace(minute=0, second=0, microsecond=0)
    rows = (await db.execute(
        select(MachineProductionHourly)
        .where(MachineProductionHourly.machine_id.in_(machine_ids),
               MachineProductionHourly.hour >= first_hour,
               MachineProductionHourly.hour < w_end)
        .order_by(MachineProductionHourly.hour.asc())
    )).scalars().all()
    return [{
        "machine_id": str(r.machine_id), "hour": _iso(r.hour),
        "count": r.count or 0, "reject_count": r.reject_count or 0,
        "job_number": r.job_number,
    } for r in rows]


async def _other_events(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> list[dict]:
    """Alerts and rejects in the window — timeline markers that come neither
    from the segments nor from the runs."""
    if not machine_ids:
        return []
    events: list[dict] = []
    for a in (await db.execute(
        select(MaintenanceAlert).where(
            MaintenanceAlert.machine_id.in_(machine_ids),
            MaintenanceAlert.created_at >= w_start,
            MaintenanceAlert.created_at < w_end,
        )
    )).scalars().all():
        events.append({
            "ts": _iso(a.created_at), "kind": "alert", "machine_id": str(a.machine_id),
            "label": a.alert_number, "ref_id": str(a.id),
            "severity": a.priority.value if a.priority else None,
        })
    for log, cat, sub in (await db.execute(
        select(RejectLog, RejectCategory.name, RejectSubcategory.name)
        .outerjoin(RejectCategory, RejectCategory.id == RejectLog.reject_category_id)
        .outerjoin(RejectSubcategory, RejectSubcategory.id == RejectLog.reject_subcategory_id)
        .where(RejectLog.machine_id.in_(machine_ids),
               RejectLog.created_at >= w_start,
               RejectLog.created_at < w_end)
    )).all():
        events.append({
            "ts": _iso(log.created_at), "kind": "reject", "machine_id": str(log.machine_id),
            "label": sub or cat or None, "ref_id": str(log.id),
            "quantity": log.quantity or 0, "job_number": log.job_number,
        })
    return sorted(events, key=lambda e: e["ts"] or "")


# ─── Public entry point ───────────────────────────────────────────────────────

async def build_timeline(db: AsyncSession, plant_id, w_start: datetime, w_end: datetime) -> dict:
    """All the replay material for a window, keyed by EQUIPMENT — the same id
    the map already uses (`MapMachine.id`), so that the frontend reuses the
    geometry, the colors, the filters and the views without any translation."""
    w_start, w_end = as_utc(w_start), as_utc(w_end)
    plant = await db.get(Plant, plant_id)

    equipment = (await db.execute(
        select(Equipment).where(Equipment.plant_id == plant_id, Equipment.active == True)  # noqa: E712
    )).scalars().all()
    # We match by EQUIPMENT, not by `machines.plant_id`: that column is
    # nullable (backfill) and a machine with a null plant_id but linked to
    # equipment in this plant would lose its entire history. It is the same
    # rule as live mode (live_status.live_details_by_equipment).
    machines = (await db.execute(
        select(Machine).where(
            Machine.equipment_id.in_([e.id for e in equipment]),
            Machine.is_active == True,  # noqa: E712
        )
    )).scalars().all() if equipment else []

    machine_by_eq = {str(m.equipment_id): m for m in machines if m.equipment_id}
    eq_by_machine = {str(m.id): str(m.equipment_id) for m in machines if m.equipment_id}
    machine_ids = [m.id for m in machines if m.equipment_id]

    stops = await _stop_layers(db, machine_ids, w_start, w_end)
    interventions, _techs = await _intervention_layers(db, machine_ids, w_start, w_end)
    tickets, ticket_spans, ticket_events = await _ticket_layers(db, machine_ids, w_start, w_end)
    runs = await _of_runs(db, machine_ids, w_start, w_end)
    production = await _production(db, machine_ids, w_start, w_end)
    events = ticket_events + await _other_events(db, machine_ids, w_start, w_end)
    pit = await _pit_events(db, plant_id, w_start, w_end)
    pit_before = await _pit_moved_before(db, plant_id, w_start)

    # Stops and runs carry the operator of the moment — the only historical source
    # (the kiosk does not keep a history of `machines.current_operator`).
    operators_by_stop: dict[str, str] = {}
    if machine_ids:
        for stop_id, name in (await db.execute(
            select(MachineStop.id, MachineOperator.name)
            .join(MachineOperator, MachineOperator.id == MachineStop.operator_id)
            .where(MachineStop.machine_id.in_(machine_ids),
                   MachineStop.started_at < w_end,
                   or_(MachineStop.ended_at.is_(None), MachineStop.ended_at > w_start))
        )).all():
            operators_by_stop[str(stop_id)] = name

    tracks: list[dict] = []
    for e in equipment:
        m = machine_by_eq.get(str(e.id))
        if m is None:
            # Without a MES layer there is no operational history at all: honest
            # grey ("no activity / unknown"), never a made-up green.
            tracks.append({
                "equipment_id": str(e.id), "machine_id": None,
                "segments": [{"start": _iso(w_start), "end": _iso(w_end), "status": "idle",
                              "reason": None, "source": "no_history", "ref_id": None, "detail": None}],
                "ticket_spans": [],
            })
            continue
        mid = str(m.id)
        layers: list[_Layer] = [_Layer(w_start, w_end, _P_BASELINE, "running", source="baseline")]
        layers += tickets.get(mid, [])
        for l in stops.get(mid, []):
            if l.ref_id in operators_by_stop:
                l.detail = {**(l.detail or {}), "operator": operators_by_stop[l.ref_id]}
            layers.append(l)
        layers += interventions.get(mid, [])
        tracks.append({
            "equipment_id": str(e.id), "machine_id": mid,
            "segments": _resolve_segments(layers, w_start, w_end),
            "ticket_spans": ticket_spans.get(mid, []),
        })

    for r in runs:
        r["equipment_id"] = eq_by_machine.get(r["machine_id"])
    for p in production:
        p["equipment_id"] = eq_by_machine.get(p["machine_id"])
    for ev in events:
        ev["equipment_id"] = eq_by_machine.get(ev.get("machine_id"))
    for pe in pit:
        if pe.get("destination_machine_id"):
            pe["destination_equipment_id"] = eq_by_machine.get(pe["destination_machine_id"])

    return {
        "plant_id": str(plant_id),
        "timezone": plant.timezone if plant else DEFAULT_TZ,
        "start": _iso(w_start),
        "end": _iso(w_end),
        "generated_at": _iso(datetime.now(timezone.utc)),
        "tracks": tracks,
        "of_runs": runs,
        "pit_events": pit,
        "pit_moved_before": pit_before,
        "production": production,
        "events": sorted(events, key=lambda e: e["ts"] or ""),
    }
