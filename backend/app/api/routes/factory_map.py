"""Factory map / digital-twin foundation.

Asset-based: lists production `equipment` for a plant, position lives on the equipment
row, live status comes from the linked `machine` (kiosk). Also serves labelled zones
and an open-ticket flag per asset for the live "control room" view.
"""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import func, select
from pydantic import BaseModel
from typing import Optional
from uuid import UUID
from jose import jwt, JWTError

from datetime import datetime, timezone
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from app.db.session import get_db, AsyncSessionLocal
from app.models.models import (
    User, UserPlant, UserRole, Plant, Equipment, FactoryZone, MapProp, FactoryView,
    HomeMapFavorite, MachineStop, StopCategory, StopSubcategory, MachineProductionLog,
    LineTvSettings, TemperatureSensor,
    JobOrder, JobOrderRun, JobOrderStatus, PitStopMovement,
)
from app.services import production_pulse

from app.core.config import settings
from app.core.security import get_current_user
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant
from app.core.permissions import require_permission
# Live status composition shared with the equipment catalog — single source of
# truth (see app/services/live_status.py). Both the 2D GET and the live WS below
# build their payloads from this one snapshot instead of re-deriving status.
from app.services.live_status import live_details_by_equipment

router = APIRouter()


class LayoutUpdate(BaseModel):
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    pos_w: Optional[float] = None
    pos_h: Optional[float] = None
    rotation_deg: Optional[float] = None
    icon_url: Optional[str] = None
    model_url: Optional[str] = None
    height_3d: Optional[float] = None
    model_scale: Optional[float] = None
    scale_y: Optional[float] = None
    scale_z: Optional[float] = None
    block_kind: Optional[str] = None
    parent_equipment_id: Optional[UUID] = None
    orbit_x: Optional[float] = None
    orbit_y: Optional[float] = None
    orbit_w: Optional[float] = None
    orbit_h: Optional[float] = None


class FloorPlanUpdate(BaseModel):
    floor_plan_url: Optional[str] = None


class ZoneCreate(BaseModel):
    name: str = "Zone"
    pos_x: float = 0
    pos_y: float = 0
    pos_w: float = 320
    pos_h: float = 220
    color: str = "#6366f1"


class ZoneUpdate(BaseModel):
    name: Optional[str] = None
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    pos_w: Optional[float] = None
    pos_h: Optional[float] = None
    color: Optional[str] = None


def _zone_dict(z: FactoryZone) -> dict:
    return {
        "id": str(z.id), "name": z.name, "color": z.color,
        "pos_x": z.pos_x, "pos_y": z.pos_y, "pos_w": z.pos_w, "pos_h": z.pos_h,
    }


class PropCreate(BaseModel):
    kind: str = "box"
    label: Optional[str] = None
    model_url: Optional[str] = None
    equipment_id: Optional[UUID] = None
    machine_id: Optional[UUID] = None
    role: Optional[str] = None
    pos_x: float = 0
    pos_y: float = 0
    pos_w: float = 120
    pos_h: float = 120
    rotation_deg: float = 0
    height_3d: Optional[float] = None


class PropUpdate(BaseModel):
    kind: Optional[str] = None
    label: Optional[str] = None
    model_url: Optional[str] = None
    equipment_id: Optional[UUID] = None
    machine_id: Optional[UUID] = None
    role: Optional[str] = None
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    pos_w: Optional[float] = None
    pos_h: Optional[float] = None
    rotation_deg: Optional[float] = None
    model_scale: Optional[float] = None
    scale_y: Optional[float] = None
    scale_z: Optional[float] = None
    height_3d: Optional[float] = None


def _prop_dict(p: MapProp) -> dict:
    return {
        "id": str(p.id), "kind": p.kind, "label": p.label, "model_url": p.model_url,
        "equipment_id": str(p.equipment_id) if p.equipment_id else None,
        "machine_id": str(p.machine_id) if p.machine_id else None,
        "role": p.role,
        "pos_x": p.pos_x, "pos_y": p.pos_y, "pos_w": p.pos_w, "pos_h": p.pos_h,
        "rotation_deg": p.rotation_deg, "model_scale": p.model_scale,
        "scale_y": p.scale_y, "scale_z": p.scale_z, "height_3d": p.height_3d,
    }


def _sensor_dict(s: TemperatureSensor) -> dict:
    """Map payload for a temperature sensor: position + latest reading (°C). The 3D
    view draws a thermometer here and the badge shows the nearest sensor's value."""
    return {
        "id": str(s.id), "name": s.name, "department": s.department,
        "pos_x": s.pos_x, "pos_y": s.pos_y, "height_3d": s.height_3d,
        "last_value_c": s.last_value_c,
        "status": s.status.value if s.status else None,
    }


class ViewCreate(BaseModel):
    name: str = "View"
    department: Optional[str] = None   # set → this is a department's pinned camera pose
    target_px_x: float = 0
    target_px_y: float = 0
    target_y: float = 0
    offset_x: float = 40
    offset_y: float = 45
    offset_z: float = 55


class ViewUpdate(BaseModel):
    name: Optional[str] = None
    department: Optional[str] = None   # link to a department (adopt its machines); null unlinks
    target_px_x: Optional[float] = None
    target_px_y: Optional[float] = None
    target_y: Optional[float] = None
    offset_x: Optional[float] = None
    offset_y: Optional[float] = None
    offset_z: Optional[float] = None


def _view_dict(v: FactoryView) -> dict:
    return {
        "id": str(v.id), "name": v.name, "department": v.department,
        "target_px_x": v.target_px_x, "target_px_y": v.target_px_y, "target_y": v.target_y,
        "offset_x": v.offset_x, "offset_y": v.offset_y, "offset_z": v.offset_z,
    }


async def _queued_ofs_by_machine(db: AsyncSession, machine_ids: list, current_by_machine: dict) -> dict:
    """{machine_id(str): {"items": [...], "total": n}} — OFs "parked" at a machine's
    output: their LAST passage was there (JobOrder.machine_id), they are not the OF
    currently loaded, still in_progress, and they have not progressed into the Pit
    Stop ledger (any movement = the material moved on). Feeds the +N queue badge on
    machine-tied conveyors — between ANY two steps (Edge → Perçage as much as
    machine → buffer). Oldest first; items capped, `total` keeps the badge honest."""
    if not machine_ids:
        return {}
    rows = (await db.execute(
        select(JobOrder).where(
            JobOrder.machine_id.in_(machine_ids),
            JobOrder.status == JobOrderStatus.in_progress,
        )
    )).scalars().all()
    if not rows:
        return {}
    moved = {r[0] for r in (await db.execute(
        select(PitStopMovement.job_order_id)
        .where(PitStopMovement.job_order_id.in_([j.id for j in rows])).distinct()
    )).all()}
    stay = [j for j in rows if j.id not in moved
            and current_by_machine.get(str(j.machine_id)) != j.job_number]
    if not stay:
        return {}
    # "parked since" = when its last run closed (the next OF was scanned there)
    since = {r[0]: r[1] for r in (await db.execute(
        select(JobOrderRun.job_order_id, func.max(JobOrderRun.ended_at))
        .where(JobOrderRun.job_order_id.in_([j.id for j in stay]))
        .group_by(JobOrderRun.job_order_id)
    )).all()}
    now = datetime.now(timezone.utc)
    out: dict = {}
    for jo in stay:
        ended = since.get(jo.id)
        age = None
        if ended is not None:
            e = ended if ended.tzinfo else ended.replace(tzinfo=timezone.utc)
            age = max(0, int((now - e).total_seconds() // 60))
        bucket = out.setdefault(str(jo.machine_id), {"items": [], "total": 0})
        bucket["total"] += 1
        bucket["items"].append({
            "job_number": jo.job_number,
            "product_name": jo.product_name,
            "age_minutes": age,
        })
    for b in out.values():
        b["items"].sort(key=lambda i: -(i["age_minutes"] if i["age_minutes"] is not None else -1))
        del b["items"][8:]
    return out


async def _pipeline_ofs_by_machine(db: AsyncSession, machine_ids: list) -> dict:
    """{machine_id(str): {"items": [...], "total": n}} — the PLANNED pipeline of a
    machine: OFs still PENDING (never scanned/started) that production planning has
    assigned to it (JobOrder.machine_id). This is the work QUEUED BEHIND the machine
    — the cutting saws have no input conveyor, only a plan. Ordered by scheduled_date
    (soonest first, nulls last) then creation, so the next OF to cut is first.
    Items capped; `total` keeps the depth honest. Drains as each OF is scanned
    (pending → in_progress moves it off this list into the loaded/current OF)."""
    if not machine_ids:
        return {}
    rows = (await db.execute(
        select(JobOrder).where(
            JobOrder.machine_id.in_(machine_ids),
            JobOrder.status == JobOrderStatus.pending,
        )
    )).scalars().all()
    if not rows:
        return {}
    today = datetime.now(timezone.utc).date()

    def _key(j):
        # soonest scheduled first; undated go last; stable tiebreak on created_at
        return (j.scheduled_date is None, j.scheduled_date or today, j.created_at or datetime.min.replace(tzinfo=timezone.utc))

    out: dict = {}
    for jo in sorted(rows, key=_key):
        bucket = out.setdefault(str(jo.machine_id), {"items": [], "total": 0})
        bucket["total"] += 1
        if len(bucket["items"]) < 10:
            sched = jo.scheduled_date
            bucket["items"].append({
                "job_number": jo.job_number,
                "product_name": jo.product_name,
                "scheduled_date": sched.isoformat() if sched else None,
                "late": bool(sched and sched < today),
                "due_today": bool(sched and sched == today),
            })
    return out


async def _stop_reasons_by_machine(db: AsyncSession, machine_ids: list) -> dict:
    """{machine_id(str): reason} for every OPEN stop among `machine_ids` — the stop's
    justification as shown on the kiosk timeline: subcategory > category > comments.
    Feeds the assembly-line balloon on the 3D map (and any stopped block's tooltip)."""
    if not machine_ids:
        return {}
    rows = (await db.execute(
        select(MachineStop.machine_id, MachineStop.comments,
               StopCategory.name.label("cat"), StopSubcategory.name.label("sub"))
        .outerjoin(StopCategory, StopCategory.id == MachineStop.stop_category_id)
        .outerjoin(StopSubcategory, StopSubcategory.id == MachineStop.stop_subcategory_id)
        .where(MachineStop.machine_id.in_(machine_ids), MachineStop.ended_at.is_(None))
    )).all()
    out = {}
    for mid, comments, cat, sub in rows:
        reason = sub or cat or (comments or "").strip() or None
        if reason:
            out[str(mid)] = reason[:200]
    return out


def _parse_hhmm(v) -> Optional[int]:
    try:
        h, m = [int(x) for x in str(v).split(":")[:2]]
        return h * 60 + m
    except (ValueError, TypeError):
        return None


def _shift_elapsed_hours(machine, wall: datetime) -> float:
    """WORKED hours elapsed inside the CURRENT shift window (machine.shifts_config,
    local wall-clock, overnight-aware), minus the machine's scheduled pauses
    (work_pauses) — drives the evolving Standard on the line TVs (target/h ×
    worked hours), mirroring the Cortex "horloges" (cadence + window + pauses).
    Falls back to the platform's default shift buckets (04-12 / 12-20 / 20-04)
    when no window is configured/matched."""
    cur = wall.hour * 60 + wall.minute

    def worked(start: int, cur_adj: int) -> float:
        mins = float(cur_adj - start)
        for p in (machine.work_pauses or []):
            if not isinstance(p, dict):
                continue
            ps, pe = _parse_hhmm(p.get("start")), _parse_hhmm(p.get("end"))
            if ps is None or pe is None or pe <= ps:
                continue
            mins -= max(0.0, min(pe, cur_adj) - max(ps, start))
        return max(0.0, mins) / 60.0

    windows: list[tuple[int, int]] = []
    for cfg in (machine.shifts_config or {}).values():
        if not isinstance(cfg, dict):
            continue
        s, e = _parse_hhmm(cfg.get("start")), _parse_hhmm(cfg.get("end"))
        if s is None or e is None:
            continue
        windows.append((s, e))
        if e > s:                                  # same-day window
            if s <= cur < e:
                return worked(s, cur)
        else:                                      # overnight window
            if cur >= s:
                return worked(s, cur)
            if cur < e:
                return worked(s, cur + 24 * 60)
    if windows:
        # Outside every configured window → the Standard HOLDS at the full value
        # of the most recently finished window (Cortex behaviour after 15:25).
        s, e = min(windows, key=lambda w: (cur - w[1]) % (24 * 60))
        return worked(s, e if e > s else e + 24 * 60)
    # default buckets (mirror machines._shift_bucket)
    start = 4 * 60 if 4 * 60 <= cur < 12 * 60 else 12 * 60 if 12 * 60 <= cur < 20 * 60 else 20 * 60
    return worked(start, cur if cur >= start else cur + 24 * 60)


async def _line_stats_by_machine(db: AsyncSession, machines: list, tz_name: Optional[str] = None) -> dict:
    """{machine_id(str): stats} for the assembly-line TVs — per line: the shift's
    actual UE count, the EVOLVING objective (target_count_per_hour × hours elapsed
    in the shift), efficiency %, and the live rate/trend from the in-memory
    production pulse (rate over the last 10 min; trend = last 2 min vs the 2
    before). Same shift/date bucketing as the production ingest, so Réel matches
    what the kiosk shows. `tz_name` = the PLANT's timezone (work windows are
    plant wall-clock; the container runs UTC)."""
    if not machines:
        return {}
    from app.api.routes.machines import _shift_and_date_for   # same bucketing as ingest
    try:
        wall = datetime.now(ZoneInfo(tz_name)) if tz_name else datetime.now().astimezone()
    except Exception:  # noqa: BLE001 — bad tz string → server clock
        wall = datetime.now().astimezone()
    wall = wall.replace(tzinfo=None)                          # plant-local wall clock
    wanted = {}                                               # (mid, date, shift) per machine
    for m in machines:
        shift_enum, log_date = _shift_and_date_for(m, wall)
        wanted[str(m.id)] = (m, shift_enum, log_date)
    rows = (await db.execute(
        select(MachineProductionLog).where(
            MachineProductionLog.machine_id.in_([m.id for m in machines]),
            MachineProductionLog.date.in_({d for _, _, d in wanted.values()}),
        )
    )).scalars().all()
    actual = {}
    for r in rows:
        key = str(r.machine_id)
        w = wanted.get(key)
        if w and r.date == w[2] and r.shift == w[1]:
            actual[key] = r.actual_count or 0
    out = {}
    for key, (m, _shift, _date) in wanted.items():
        rate, trend = production_pulse.stats(m.id)
        target_rate = m.target_count_per_hour or 0
        elapsed_h = _shift_elapsed_hours(m, wall)
        evolving = round(target_rate * elapsed_h)
        act = actual.get(key, 0)
        out[key] = {
            "actual": act,
            "rate_per_h": round(rate, 1),
            "trend": trend,
            "target_per_hour": target_rate,
            "evolving_target": evolving,
            "efficiency_pct": round(act / evolving * 100, 1) if evolving > 0 else None,
        }
    return out


async def _global_line_stats(db: AsyncSession, plant_id, per_line: dict, tz_name: Optional[str]) -> Optional[dict]:
    """The GLOBAL clock for the assembly lines (Cortex "QS - Global"): Réel/rate
    are the MEASURED Σ of the per-line stats; the Standard comes from the plant's
    OWN global objective (LineTvSettings cadence/window/pauses — independent of
    the line objectives), falling back to Σ of the line standards while the
    global objective isn't configured. None when the plant has no lines."""
    if not per_line:
        return None
    actual = sum(s["actual"] for s in per_line.values())
    rate = sum(s["rate_per_h"] for s in per_line.values())
    up = sum(1 for s in per_line.values() if s["trend"] == "up")
    down = sum(1 for s in per_line.values() if s["trend"] == "down")
    row = (await db.execute(
        select(LineTvSettings).where(LineTvSettings.plant_id == plant_id)
    )).scalar_one_or_none()
    if row and row.global_cadence_per_hour and row.global_work_start and row.global_work_end:
        # Reuse the elapsed-hours engine through a shim shaped like a machine.
        shim = SimpleNamespace(
            shifts_config={"day": {"start": row.global_work_start, "end": row.global_work_end}},
            work_pauses=row.global_pauses or [],
        )
        try:
            wall = datetime.now(ZoneInfo(tz_name)) if tz_name else datetime.now().astimezone()
        except Exception:  # noqa: BLE001
            wall = datetime.now().astimezone()
        target = row.global_cadence_per_hour
        evolving = round(target * _shift_elapsed_hours(shim, wall.replace(tzinfo=None)))
    else:
        target = sum(s["target_per_hour"] for s in per_line.values())
        evolving = sum(s["evolving_target"] for s in per_line.values())
    return {
        "actual": actual,
        "rate_per_h": round(rate, 1),
        "trend": "up" if up > down else "down" if down > up else "flat",
        "target_per_hour": target,
        "evolving_target": evolving,
        "efficiency_pct": round(actual / evolving * 100, 1) if evolving > 0 else None,
    }


@router.get("/{plant_id}")
async def get_factory_map(
    plant_id: UUID,
    asset_type: str = Query("production"),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    plant = await db.get(Plant, plant_id)
    if not plant or not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")

    eq_query = select(Equipment).where(Equipment.plant_id == plant_id, Equipment.active == True)
    if asset_type and asset_type != "all":
        eq_query = eq_query.where(Equipment.asset_type == asset_type)
    equipment = (await db.execute(eq_query)).scalars().all()

    # One shared snapshot: effective status + operator + open-ticket badge, with
    # the same machine > cell > equipment rules and parent-machine inheritance
    # used everywhere (see live_status.live_details_by_equipment).
    details = await live_details_by_equipment(db, equipment)
    stop_reasons = await _stop_reasons_by_machine(
        db, [d.machine.id for d in details.values() if d.machine])
    # Live TV stats for the assembly lines only (Réel / Standard / trend / eff.)
    line_stats = await _line_stats_by_machine(
        db, [details[str(e.id)].machine for e in equipment
             if e.block_kind == "assembly_line" and details[str(e.id)].machine],
        tz_name=plant.timezone)
    global_stats = await _global_line_stats(db, plant_id, line_stats, plant.timezone)
    machines_all = [d.machine for d in details.values() if d.machine]
    queued = await _queued_ofs_by_machine(
        db, [m.id for m in machines_all],
        {str(m.id): m.current_job_number for m in machines_all})
    pipeline = await _pipeline_ofs_by_machine(db, [m.id for m in machines_all])

    items = []
    for e in equipment:
        la = details[str(e.id)]
        m = la.machine
        ticket = la.open_ticket
        items.append({
            "id": str(e.id),
            "machine_id": str(m.id) if m else None,
            "page_slug": m.page_slug if m else None,
            "name": e.name,
            "code": e.code,
            "status": la.status,
            "operator": la.operator,
            "technicians": la.technicians,
            "stop_reason": stop_reasons.get(str(m.id)) if m else None,
            "line_stats": line_stats.get(str(m.id)) if m else None,
            # OF currently loaded at the machine's kiosk — shown on the linked
            # input/output conveyors (and kept live by the WS push below) — plus
            # the OFs PARKED at its output (worked there, not yet scanned at the
            # next step nor arrived in the Pit Stop): the conveyor's +N badge.
            "current_job_number": m.current_job_number if m else None,
            "queued_ofs": queued.get(str(m.id), {}).get("items") if m else None,
            "queued_total": queued.get(str(m.id), {}).get("total", 0) if m else 0,
            # Planned pipeline behind the machine (pending OFs assigned to it).
            "pipeline_ofs": pipeline.get(str(m.id), {}).get("items") if m else None,
            "pipeline_total": pipeline.get(str(m.id), {}).get("total", 0) if m else 0,
            "department": e.department,
            "family": e.family,
            "subtype": e.subtype,
            "function_label": e.function_label,
            "open_ticket": ticket is not None,
            "open_ticket_id": ticket["id"] if ticket else None,
            "open_ticket_number": ticket["number"] if ticket else None,
            "pos_x": e.pos_x, "pos_y": e.pos_y, "pos_w": e.pos_w, "pos_h": e.pos_h,
            "rotation_deg": e.rotation_deg, "icon_url": e.icon_url,
            "model_url": e.model_url, "height_3d": e.height_3d,
            "model_scale": e.model_scale, "scale_y": e.scale_y, "scale_z": e.scale_z,
            "block_kind": e.block_kind,
            "asset_type": e.asset_type,
            "parent_equipment_id": str(e.parent_equipment_id) if e.parent_equipment_id else None,
            "orbit_x": e.orbit_x, "orbit_y": e.orbit_y, "orbit_w": e.orbit_w, "orbit_h": e.orbit_h,
            "placed": e.pos_x is not None and e.pos_y is not None,
        })

    zones = (await db.execute(
        select(FactoryZone).where(FactoryZone.plant_id == plant_id)
    )).scalars().all()

    props = (await db.execute(
        select(MapProp).where(MapProp.plant_id == plant_id)
    )).scalars().all()

    sensors = (await db.execute(
        select(TemperatureSensor).where(
            TemperatureSensor.plant_id == plant_id, TemperatureSensor.enabled == True)  # noqa: E712
    )).scalars().all()

    views = (await db.execute(
        select(FactoryView).where(FactoryView.plant_id == plant_id)
        .order_by(FactoryView.sort_order, FactoryView.created_at)
    )).scalars().all()

    # This user's favourite landing view for the Home-page overview of this plant.
    home_view_id = (await db.execute(
        select(HomeMapFavorite.view_id).where(
            HomeMapFavorite.user_id == ctx.user.id, HomeMapFavorite.plant_id == plant_id)
    )).scalar_one_or_none()

    # Efficiency-colour thresholds for the assembly-line TVs (green ≥ / amber ≥).
    tv = (await db.execute(
        select(LineTvSettings).where(LineTvSettings.plant_id == plant_id)
    )).scalar_one_or_none()

    return {
        "plant_id": str(plant_id),
        "plant_name": plant.name,
        "line_tv_thresholds": {"green_from": tv.green_from if tv else 95.0,
                               "amber_from": tv.amber_from if tv else 80.0},
        "global_line_stats": global_stats,
        "floor_plan_url": plant.floor_plan_url,
        "machines": items,
        "zones": [_zone_dict(z) for z in zones],
        "props": [_prop_dict(p) for p in props],
        "sensors": [_sensor_dict(s) for s in sensors],
        "views": [_view_dict(v) for v in views],
        "home_view_id": str(home_view_id) if home_view_id else None,
    }


@router.patch("/item/{equipment_id}")
async def update_item_layout(
    equipment_id: UUID,
    data: LayoutUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    e = ensure_same_plant(await db.get(Equipment, equipment_id), ctx, detail="Equipment not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(e, field, value)
    await db.commit()
    return {"ok": True}


@router.patch("/{plant_id}/floor-plan")
async def set_floor_plan(
    plant_id: UUID,
    data: FloorPlanUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    plant = await db.get(Plant, plant_id)
    if not plant or not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    plant.floor_plan_url = data.floor_plan_url
    await db.commit()
    return {"ok": True}


# ── Zones ─────────────────────────────────────────────────────────────────────
@router.post("/{plant_id}/zones")
async def create_zone(
    plant_id: UUID,
    data: ZoneCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    plant = await db.get(Plant, plant_id)
    if not plant or not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    z = FactoryZone(plant_id=plant_id, **data.model_dump())
    db.add(z)
    await db.commit()
    await db.refresh(z)
    return _zone_dict(z)


@router.patch("/zone/{zone_id}")
async def update_zone(
    zone_id: UUID,
    data: ZoneUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    z = ensure_same_plant(await db.get(FactoryZone, zone_id), ctx, detail="Zone not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(z, field, value)
    await db.commit()
    return {"ok": True}


@router.delete("/zone/{zone_id}", status_code=204)
async def delete_zone(
    zone_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    z = await db.get(FactoryZone, zone_id)
    if z and ctx.can_access(z.plant_id):
        await db.delete(z)
        await db.commit()


# ── Decorative props (non-tracked blocks) ─────────────────────────────────────
@router.post("/{plant_id}/props")
async def create_prop(
    plant_id: UUID,
    data: PropCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    plant = await db.get(Plant, plant_id)
    if not plant or not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    p = MapProp(plant_id=plant_id, **data.model_dump())
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return _prop_dict(p)


@router.patch("/prop/{prop_id}")
async def update_prop(
    prop_id: UUID,
    data: PropUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    p = ensure_same_plant(await db.get(MapProp, prop_id), ctx, detail="Prop not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(p, field, value)
    await db.commit()
    return {"ok": True}


@router.delete("/prop/{prop_id}", status_code=204)
async def delete_prop(
    prop_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    p = await db.get(MapProp, prop_id)
    if p and ctx.can_access(p.plant_id):
        await db.delete(p)
        await db.commit()


# ── Temperature sensors (position only; CRUD lives in temperature_sensors.py) ──
class SensorLayoutUpdate(BaseModel):
    pos_x: Optional[float] = None
    pos_y: Optional[float] = None
    height_3d: Optional[float] = None


@router.get("/{plant_id}/sensors")
async def list_map_sensors(
    plant_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Lightweight sensor readings for the map — polled by the 3D view so the
    thermometers + badge stay live without reloading the whole map. Same plant
    access as the map GET (no settings_devices needed, so any map viewer sees it)."""
    if not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    rows = (await db.execute(
        select(TemperatureSensor).where(
            TemperatureSensor.plant_id == plant_id, TemperatureSensor.enabled == True)  # noqa: E712
    )).scalars().all()
    return [_sensor_dict(s) for s in rows]


@router.patch("/sensor/{sensor_id}")
async def update_sensor_layout(
    sensor_id: UUID,
    data: SensorLayoutUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    s = ensure_same_plant(await db.get(TemperatureSensor, sensor_id), ctx, detail="Sensor not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(s, field, value)
    await db.commit()
    return {"ok": True}


# ── Saved 3D camera views ─────────────────────────────────────────────────────
@router.post("/{plant_id}/views")
async def create_view(
    plant_id: UUID,
    data: ViewCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    plant = await db.get(Plant, plant_id)
    if not plant or not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    count = len((await db.execute(
        select(FactoryView.id).where(FactoryView.plant_id == plant_id)
    )).all())
    v = FactoryView(plant_id=plant_id, sort_order=count, **data.model_dump())
    db.add(v)
    await db.commit()
    await db.refresh(v)
    return _view_dict(v)


@router.patch("/view/{view_id}")
async def update_view(
    view_id: UUID,
    data: ViewUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    v = ensure_same_plant(await db.get(FactoryView, view_id), ctx, detail="View not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(v, field, value)
    await db.commit()
    return {"ok": True}


@router.delete("/view/{view_id}", status_code=204)
async def delete_view(
    view_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("machines", "update")),
):
    v = await db.get(FactoryView, view_id)
    if v and ctx.can_access(v.plant_id):
        await db.delete(v)
        await db.commit()


# ── Home-page favourite view (per user, per plant) ────────────────────────────
class HomeViewUpdate(BaseModel):
    view_id: Optional[UUID] = None   # None → clear (Home reverts to automatic top-down)


@router.put("/{plant_id}/home-view")
async def set_home_view(
    plant_id: UUID,
    data: HomeViewUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # Personal preference — any user who can see this plant may set their own.
    if not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    if data.view_id is not None:
        v = await db.get(FactoryView, data.view_id)
        if not v or v.plant_id != plant_id:
            raise HTTPException(status_code=404, detail="View not found")
    existing = await db.get(HomeMapFavorite, {"user_id": ctx.user.id, "plant_id": plant_id})
    if data.view_id is None:
        if existing:
            await db.delete(existing)
    elif existing:
        existing.view_id = data.view_id
    else:
        db.add(HomeMapFavorite(user_id=ctx.user.id, plant_id=plant_id, view_id=data.view_id))
    await db.commit()
    return {"ok": True, "home_view_id": str(data.view_id) if data.view_id else None}


# ── Live status (WebSocket) ───────────────────────────────────────────────────
async def _status_payload(db: AsyncSession, plant_id) -> dict:
    equipment = (await db.execute(
        select(Equipment).where(Equipment.plant_id == plant_id, Equipment.active == True)
    )).scalars().all()
    # Same shared snapshot as the GET endpoint so the LIVE push follows parent
    # machines, cobot telemetry and open-ticket badges identically.
    details = await live_details_by_equipment(db, equipment)
    stop_reasons = await _stop_reasons_by_machine(
        db, [d.machine.id for d in details.values() if d.machine])
    tz_name = (await db.execute(
        select(Plant.timezone).where(Plant.id == plant_id)
    )).scalar_one_or_none()
    line_stats = await _line_stats_by_machine(
        db, [details[str(e.id)].machine for e in equipment
             if e.block_kind == "assembly_line" and details[str(e.id)].machine],
        tz_name=tz_name)
    # Thresholds ride the push too — colour edits on the config page reach open
    # maps within one tick, no reload.
    tv = (await db.execute(
        select(LineTvSettings).where(LineTvSettings.plant_id == plant_id)
    )).scalar_one_or_none()
    machines_all = [d.machine for d in details.values() if d.machine]
    queued = await _queued_ofs_by_machine(
        db, [m.id for m in machines_all],
        {str(m.id): m.current_job_number for m in machines_all})
    pipeline = await _pipeline_ofs_by_machine(db, [m.id for m in machines_all])
    out = []
    for e in equipment:
        la = details[str(e.id)]
        ticket = la.open_ticket
        m = la.machine
        out.append({
            "id": str(e.id), "status": la.status, "operator": la.operator,
            "technicians": la.technicians,
            "stop_reason": stop_reasons.get(str(m.id)) if m else None,
            "line_stats": line_stats.get(str(m.id)) if m else None,
            "current_job_number": m.current_job_number if m else None,
            "queued_ofs": queued.get(str(m.id), {}).get("items") if m else None,
            "queued_total": queued.get(str(m.id), {}).get("total", 0) if m else 0,
            "pipeline_ofs": pipeline.get(str(m.id), {}).get("items") if m else None,
            "pipeline_total": pipeline.get(str(m.id), {}).get("total", 0) if m else 0,
            "open_ticket": ticket is not None,
            "open_ticket_id": ticket["id"] if ticket else None,
            "open_ticket_number": ticket["number"] if ticket else None,
        })
    return {
        "machines": out,
        "line_tv_thresholds": {"green_from": tv.green_from if tv else 95.0,
                               "amber_from": tv.amber_from if tv else 80.0},
        "global_line_stats": await _global_line_stats(db, plant_id, line_stats, tz_name),
    }


@router.websocket("/ws/{plant_id}")
async def factory_map_ws(websocket: WebSocket, plant_id: UUID, token: str = ""):
    """Pushes live machine status for the plant every few seconds (token via query).
    The token's user must hold a membership in the requested plant — the WS is
    plant-scoped data, same rules as the REST map endpoint."""
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise JWTError("no sub")
    except JWTError:
        await websocket.close(code=1008)
        return
    async with AsyncSessionLocal() as db:
        user = await db.get(User, UUID(user_id))
        if not user or not user.active:
            await websocket.close(code=1008)
            return
        if user.role != UserRole.admin:
            member = (await db.execute(
                select(UserPlant.id).where(
                    UserPlant.user_id == user.id, UserPlant.plant_id == plant_id
                )
            )).first()
            if member is None:
                await websocket.close(code=1008)
                return
    await websocket.accept()
    try:
        while True:
            async with AsyncSessionLocal() as db:
                payload = await _status_payload(db, plant_id)
            await websocket.send_json(payload)
            await asyncio.sleep(4)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
