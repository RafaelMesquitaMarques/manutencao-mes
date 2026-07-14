import re
import secrets
from datetime import datetime, timezone, date, timedelta
from uuid import UUID
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.db.session import get_db
from app.models.models import (
    LineTvSettings,
    Machine, Equipment, Department, MaintenanceTicket, TicketStatus, WorkOrder, WorkOrderType,
    User, MachineStatus, AlertPriority,
    MachineStop, MachineOperator, StopCategory, StopSubcategory,
    RejectCategory, RejectSubcategory, RejectLog,
    AlertShift, JobOrder, JobOrderSource, MachineProductionLog, MachineProductionHourly,
    MachineHistory, Technician, MachineIntervention,
    MaintenanceAlert, AlertStatus, AlertProblemType,
    CleaningChecklist, CleaningChecklistItem, StopCleaningResponse,
)
from app.schemas.maintenance import (
    MachineOut, MachineListResponse, MachinePageData, TicketForMachine,
    MachineStatusUpdate, MaintenanceRequestCreate, MESData,
    MachineJobUpdate, MachineOperatorUpdate, MachineConfigUpdate,
    MachineRejectUpdate, MachineStopCreate, MachineStopClose,
    MachineStopOut, StopCategoryMini, StopSubcategoryMini,
    MachineOperatorOut, MachineOperatorCreate, MachineOperatorUpdate as OperatorPatch,
    MESDataExtended, MachineCreate, MachinePatch,
    StopCategoryOut, StopCategoryCreate, StopCategoryUpdate,
    StopSubcategoryOut, StopSubcategoryCreate, StopSubcategoryUpdate,
    RejectCategoryOut, RejectCategoryCreate, RejectCategoryUpdate,
    RejectSubcategoryOut, RejectSubcategoryCreate, RejectSubcategoryUpdate,
    RejectLogCreate, CloneCategoriesRequest, SortOrderItem,
    JobOrderOut, JobOrderCreate,
)
from app.core.security import get_current_user
from app.core.permissions import require_permission
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_condition, plant_scoped
from app.services.ticket_service import TicketService, _next_ticket_number, _next_alert_number
from app.services.mes_service import MesService, shift_windows
from app.services.intervention_sync import apply_production_signal
from app.services.job_order_service import (
    scan_job_order_at_machine, attribute_production, complete_unit_at_machine,
)
from app.services import production_pulse
from app.services.equipment_machine_sync import ensure_machine_for_equipment

router = APIRouter()

_UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', re.I)


async def _get_machine(ref: str, db: AsyncSession) -> Machine:
    if _UUID_RE.match(ref):
        m = await db.get(Machine, ref)
        if m:
            return m
        # Ref is a UUID but no Machine found — check if it's an Equipment UUID
        eq = await db.get(Equipment, ref)
        if eq:
            # If a machine already exists with the same code, return that
            if eq.code:
                existing = await db.execute(select(Machine).where(Machine.code == eq.code))
                m = existing.scalar_one_or_none()
                if m:
                    if m.equipment_id is None:
                        m.equipment_id = eq.id
                        await db.commit()
                    return m
            # Auto-provision a Machine record with the equipment's UUID
            m = Machine(id=eq.id, name=eq.name, code=eq.code, equipment_id=eq.id, is_active=True)
            db.add(m)
            await db.commit()
            await db.refresh(m)
            return m
    else:
        r = await db.execute(select(Machine).where(Machine.page_slug == ref))
        m = r.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Machine not found")
    return m


async def _get_machine_scoped(ref: str, db: AsyncSession, ctx: PlantContext) -> Machine:
    """_get_machine + plant visibility: a ref owned by a plant the user has no
    membership in gets the same 404 as a missing machine. Only for the
    authenticated (non-kiosk) endpoints — kiosk auth is phase 4."""
    return ensure_same_plant(await _get_machine(ref, db), ctx, detail="Machine not found")


def _machine_to_page_data(machine: Machine, open_tickets: list) -> MachinePageData:
    cstatus = machine.current_status.value if hasattr(machine.current_status, "value") else str(machine.current_status or MachineStatus.running)
    # An active maintenance ticket/intervention means the machine is NOT simply "running"
    # — reflect it in the kiosk header (matches the factory-map effective status).
    if open_tickets and cstatus == "running":
        cstatus = "maintenance"
    cshift  = machine.current_shift.value if machine.current_shift and hasattr(machine.current_shift, "value") else (str(machine.current_shift) if machine.current_shift else None)
    clang   = machine.page_language.value if machine.page_language and hasattr(machine.page_language, "value") else (str(machine.page_language) if machine.page_language else "fr")
    currency = machine.hourly_rate_currency.value if machine.hourly_rate_currency and hasattr(machine.hourly_rate_currency, "value") else (str(machine.hourly_rate_currency) if machine.hourly_rate_currency else "CAD")
    return MachinePageData(
        id=machine.id, name=machine.name, code=machine.code,
        serial_number=machine.serial_number,
        department=machine.department, location=machine.location,
        is_active=machine.is_active,
        current_status=cstatus,
        current_operator=machine.current_operator,
        current_shift=cshift,
        current_job_number=machine.current_job_number,
        last_maintenance_at=machine.last_maintenance_at,
        last_stop_at=machine.last_stop_at,
        last_start_at=machine.last_start_at,
        page_slug=machine.page_slug,
        page_language=clang,
        target_availability_pct=machine.target_availability_pct or 70.0,
        target_count=machine.target_count,
        target_count_per_shift=getattr(machine, "target_count_per_shift", None),
        target_count_per_hour=getattr(machine, "target_count_per_hour", None),
        show_production_panel=machine.show_production_panel if machine.show_production_panel is not None else True,
        show_reject_panel=machine.show_reject_panel if machine.show_reject_panel is not None else True,
        show_availability_gauge=machine.show_availability_gauge if machine.show_availability_gauge is not None else True,
        show_job_number=machine.show_job_number if machine.show_job_number is not None else True,
        custom_color=machine.custom_color,
        display_name=machine.display_name,
        hourly_rate=getattr(machine, "hourly_rate", None),
        hourly_rate_currency=currency,
        kiosk_layout=getattr(machine, "kiosk_layout", None),
        shifts_config=getattr(machine, "shifts_config", None),
        signal_driven=bool(getattr(machine, "signal_ingest_token", None)),
        open_tickets=open_tickets,
    )


# ── List / Create machines ────────────────────────────────────────────────────

@router.get("/", response_model=MachineListResponse)
async def list_machines(
    include_inactive: bool = False,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # Soft-deleted machines (is_active=False, set by DELETE) must not surface in
    # dropdowns/lists — they "no longer exist" to the user. Callers that manage
    # deleted records can opt in with ?include_inactive=true.
    stmt = plant_scoped(select(Machine).order_by(Machine.name), Machine, ctx)
    if not include_inactive:
        stmt = stmt.where(Machine.is_active == True)  # noqa: E712
    r = await db.execute(stmt)
    items = r.scalars().all()
    return MachineListResponse(total=len(items), items=items)


# ── Assembly-line objectives (Cortex "horloges" model) ─────────────────────────
# Per line: cadence (units/h), work window and scheduled pauses — everything the
# evolving Standard on the line TVs needs. REGISTERED BEFORE the /{ref} routes so
# the literal path wins. Edited in /settings/line-objectives (settings_machines).

class PauseIn(BaseModel):
    start: str          # "HH:MM"
    end: str


class ShiftIn(BaseModel):
    enabled: bool = False
    start: Optional[str] = None    # "HH:MM"
    end: Optional[str] = None


class LineObjectiveIn(BaseModel):
    cadence_per_hour: int = 0
    work_start: Optional[str] = None    # "HH:MM" — the GLOBAL clock's single window
    work_end: Optional[str] = None
    # Per-line shift grid (assembly lines): keys morning/afternoon/night, each a
    # ShiftIn. When present it OVERRIDES work_start/work_end for that line.
    shifts: Optional[Dict[str, ShiftIn]] = None
    pauses: List[PauseIn] = []


# The three canonical shifts a line can run, aligned with AlertShift and the
# platform's default buckets (morning 04-12 / afternoon 12-20 / night 20-04), so
# production/OEE keep bucketing by the same names. Defaults: only the day shift on.
SHIFT_KEYS = ("morning", "afternoon", "night")
_DEFAULT_SHIFT_TIMES = {
    "morning":   ("07:00", "15:30"),
    "afternoon": ("15:30", "23:30"),
    "night":     ("23:30", "07:00"),
}


def _default_shift_schedule() -> dict:
    """A fresh line: the day shift enabled (07:00–15:30), evening/night pre-filled
    but off — ready to switch on for a future capacity increase."""
    return {
        k: {"start": s, "end": e, "enabled": (k == "morning")}
        for k, (s, e) in _DEFAULT_SHIFT_TIMES.items()
    }


def _schedule_from_config(shifts_config) -> dict:
    """Build a full 3-shift grid from a legacy shifts_config (lines that predate
    shift_schedule): each configured window enables the bucket its start falls in;
    the rest fall back to the pre-filled defaults, disabled."""
    sched = _default_shift_schedule()
    for cfg in (shifts_config or {}).values():
        if not isinstance(cfg, dict) or not cfg.get("start"):
            continue
        try:
            sh = int(str(cfg["start"]).split(":")[0])
        except (ValueError, TypeError):
            continue
        key = _shift_bucket(sh).value    # morning / afternoon / night
        sched[key] = {"start": cfg.get("start"), "end": cfg.get("end"), "enabled": True}
    return sched


def _config_from_schedule(schedule: dict) -> dict:
    """The derived shifts_config: only the ENABLED windows, as {key:{start,end}} —
    exactly the shape every existing consumer already reads."""
    out = {}
    for key in SHIFT_KEYS:
        s = schedule.get(key) or {}
        if s.get("enabled") and s.get("start") and s.get("end"):
            out[key] = {"start": s["start"], "end": s["end"]}
    return out


def _line_objective_out(m: Machine) -> dict:
    schedule = m.shift_schedule or _schedule_from_config(m.shifts_config)
    win = next((c for c in (m.shifts_config or {}).values() if isinstance(c, dict)), {})
    return {
        "machine_id": str(m.id),
        "name": m.display_name or m.name,
        "code": m.code,
        "cadence_per_hour": m.target_count_per_hour or 0,
        "work_start": win.get("start"),
        "work_end": win.get("end"),
        "shifts": schedule,
        "pauses": m.work_pauses or [],
    }


async def _assembly_line_machines(db: AsyncSession, ctx: PlantContext) -> List[Machine]:
    rows = (await db.execute(
        plant_scoped(
            select(Machine)
            .join(Equipment, Equipment.id == Machine.equipment_id)
            .where(Equipment.block_kind == "assembly_line", Machine.is_active == True)  # noqa: E712
            .order_by(Machine.name),
            Machine, ctx,
        )
    )).scalars().all()
    return list(rows)


class TvSettingsIn(BaseModel):
    green_from: float = 95.0    # efficiency ≥ this → green
    amber_from: float = 80.0    # efficiency ≥ this → amber; below → red


@router.get("/assembly-lines/tv-settings")
async def get_tv_settings(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "view")),
):
    """The plant's TV efficiency-colour thresholds (defaults 95/80)."""
    row = (await db.execute(
        select(LineTvSettings).where(LineTvSettings.plant_id == ctx.plant_id)
    )).scalar_one_or_none()
    return {"green_from": row.green_from if row else 95.0,
            "amber_from": row.amber_from if row else 80.0}


@router.put("/assembly-lines/tv-settings")
async def set_tv_settings(
    data: TvSettingsIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "update")),
):
    """Upsert the plant's TV efficiency-colour thresholds (green ≥ / amber ≥)."""
    if not (0 <= data.amber_from <= data.green_from <= 200):
        raise HTTPException(status_code=422, detail="invalid_thresholds")
    row = (await db.execute(
        select(LineTvSettings).where(LineTvSettings.plant_id == ctx.plant_id)
    )).scalar_one_or_none()
    if row is None:
        row = LineTvSettings(plant_id=ctx.plant_id)
        db.add(row)
    row.green_from = data.green_from
    row.amber_from = data.amber_from
    await db.commit()
    return {"green_from": row.green_from, "amber_from": row.amber_from}


@router.get("/assembly-lines/global-objective")
async def get_global_objective(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "view")),
):
    """The plant's GLOBAL clock objective (independent of the per-line ones)."""
    row = (await db.execute(
        select(LineTvSettings).where(LineTvSettings.plant_id == ctx.plant_id)
    )).scalar_one_or_none()
    return {
        "cadence_per_hour": (row.global_cadence_per_hour if row else 0) or 0,
        "work_start": row.global_work_start if row else None,
        "work_end": row.global_work_end if row else None,
        "pauses": (row.global_pauses if row else None) or [],
    }


@router.put("/assembly-lines/global-objective")
async def set_global_objective(
    data: LineObjectiveIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "update")),
):
    """Set the GLOBAL clock's own cadence/window/pauses (Cortex "QS - Global"):
    drives the global TV's Standard; the global Réel stays the measured Σ of
    the lines. Cadence 0 → the global Standard falls back to Σ of the lines'."""
    hhmm = re.compile(r"^\d{1,2}:\d{2}$")
    for v in [data.work_start, data.work_end, *(x for p in data.pauses for x in (p.start, p.end))]:
        if v is not None and not hhmm.match(v):
            raise HTTPException(status_code=422, detail="invalid_time_format")
    row = (await db.execute(
        select(LineTvSettings).where(LineTvSettings.plant_id == ctx.plant_id)
    )).scalar_one_or_none()
    if row is None:
        row = LineTvSettings(plant_id=ctx.plant_id)
        db.add(row)
    row.global_cadence_per_hour = max(0, data.cadence_per_hour)
    row.global_work_start = data.work_start
    row.global_work_end = data.work_end
    row.global_pauses = [p.model_dump() for p in data.pauses]
    await db.commit()
    return {
        "cadence_per_hour": row.global_cadence_per_hour or 0,
        "work_start": row.global_work_start,
        "work_end": row.global_work_end,
        "pauses": row.global_pauses or [],
    }


@router.get("/assembly-lines")
async def list_assembly_lines(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "view")),
):
    """The plant's assembly lines with their production objectives (cadence,
    work window, pauses) — the /settings/line-objectives page."""
    return [_line_objective_out(m) for m in await _assembly_line_machines(db, ctx)]


@router.put("/assembly-lines/{machine_id}/objective")
async def set_assembly_line_objective(
    machine_id: UUID,
    data: LineObjectiveIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "update")),
):
    """Set one line's objective: cadence → target_count_per_hour (drives the TV
    Standard + derived per-shift/day targets); the 3-shift grid (`shifts`, keys
    morning/afternoon/night, each start/end/enabled) → shift_schedule, from which
    shifts_config (the ENABLED windows only) is derived so every existing consumer
    keeps working; pauses → work_pauses (discounted from the evolving Standard).
    At least one shift must be enabled. Legacy single-window (work_start/work_end)
    is still accepted when `shifts` is omitted."""
    machine = ensure_same_plant(await db.get(Machine, machine_id), ctx, detail="Machine not found")
    hhmm = re.compile(r"^\d{1,2}:\d{2}$")

    if data.shifts is not None:
        # Normalise to the three canonical keys; ignore any unknown key.
        schedule = _default_shift_schedule()
        for key in SHIFT_KEYS:
            incoming = data.shifts.get(key)
            if incoming is None:
                schedule[key]["enabled"] = False
                continue
            for v in (incoming.start, incoming.end):
                if v is not None and not hhmm.match(v):
                    raise HTTPException(status_code=422, detail="invalid_time_format")
            schedule[key] = {
                "start": incoming.start or schedule[key]["start"],
                "end": incoming.end or schedule[key]["end"],
                "enabled": bool(incoming.enabled),
            }
        shifts_config = _config_from_schedule(schedule)
        if not shifts_config:
            raise HTTPException(status_code=422, detail="at_least_one_shift")
        machine.shift_schedule = schedule
        machine.shifts_config = shifts_config
    else:  # legacy single-window path (kept for callers not sending the grid)
        for v in [data.work_start, data.work_end]:
            if v is not None and not hhmm.match(v):
                raise HTTPException(status_code=422, detail="invalid_time_format")
        if data.work_start and data.work_end:
            machine.shifts_config = {"day": {"start": data.work_start, "end": data.work_end}}
            machine.shift_schedule = _schedule_from_config(machine.shifts_config)

    for p in data.pauses:
        for v in (p.start, p.end):
            if v is not None and not hhmm.match(v):
                raise HTTPException(status_code=422, detail="invalid_time_format")

    machine.target_count_per_hour = max(0, data.cadence_per_hour)
    # Keep per-shift/day targets consistent with the cadence and the now-active hours.
    per_shift, daily = _derive_targets_from_hourly(
        machine.target_count_per_hour, machine.shifts_config)
    machine.target_count_per_shift = per_shift
    machine.target_count = daily
    machine.work_pauses = [p.model_dump() for p in data.pauses]
    await db.commit()
    await db.refresh(machine)
    return _line_objective_out(machine)


class AssemblyLineCreate(BaseModel):
    name: str
    code: str
    cadence_per_hour: int = 0


async def _assemblage_department(db: AsyncSession, plant_id) -> str:
    """The plant's registered 'Assemblage' department name (created if absent),
    so the new line lines up with the department picker and OF filters — same
    rule the seed_assembly_lines script uses."""
    dept = (await db.execute(
        select(Department).where(
            Department.plant_id == plant_id,
            func.lower(Department.name) == "assemblage",
        )
    )).scalars().first()
    if dept is None:
        dept = Department(plant_id=plant_id, name="Assemblage")
        db.add(dept)
        await db.flush()
    return dept.name


@router.post("/assembly-lines", status_code=201)
async def create_assembly_line(
    data: AssemblyLineCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "update")),
):
    """Add an assembly line to the active plant. Creates the Equipment
    (block_kind='assembly_line', department Assemblage) whose kiosk/Machine is
    auto-provisioned by ensure_machine_for_equipment, then applies the cadence.
    The signal token + ADAM/Cortex device and the map placement are wired
    afterwards in /settings/devices — exactly like a seeded line. Lets each plant
    (e.g. Las Vegas, fewer lines) carry only the lines it actually has."""
    name = (data.name or "").strip()
    code = (data.code or "").strip()
    if not name or not code:
        raise HTTPException(status_code=422, detail="name_and_code_required")

    # The code must be free among the plant's equipment and across kiosk machines
    # (Machine.code is globally unique) so the line can actually carry it.
    dup_eq = (await db.execute(plant_scoped(
        select(Equipment.id).where(func.lower(Equipment.code) == code.lower()),
        Equipment, ctx,
    ))).first()
    dup_m = (await db.execute(
        select(Machine.id).where(func.lower(Machine.code) == code.lower())
    )).first()
    if dup_eq or dup_m:
        raise HTTPException(status_code=409, detail="code_taken")

    department = await _assemblage_department(db, ctx.plant_id)
    eq = Equipment(
        plant_id=ctx.plant_id,
        code=code,
        name=name,
        department=department,
        asset_type="production",
        block_kind="assembly_line",
        function_label="Ligne d'assemblage de meubles [furniture assembly line]",
    )
    db.add(eq)
    await db.flush()

    # Same kiosk/Machine auto-provisioning the equipment create endpoint uses.
    await ensure_machine_for_equipment(db, eq)
    await db.flush()

    machine = (await db.execute(
        select(Machine).where(Machine.equipment_id == eq.id)
    )).scalars().first()
    if machine is None:
        raise HTTPException(status_code=500, detail="line_kiosk_not_created")
    # Start on the default single day shift (07:00–15:30), evening/night pre-filled
    # but off — the operator switches them on later to add capacity.
    machine.shift_schedule = _default_shift_schedule()
    machine.shifts_config = _config_from_schedule(machine.shift_schedule)
    if data.cadence_per_hour:
        machine.target_count_per_hour = max(0, data.cadence_per_hour)
        per_shift, daily = _derive_targets_from_hourly(
            machine.target_count_per_hour, machine.shifts_config)
        machine.target_count_per_shift = per_shift
        machine.target_count = daily

    await db.commit()
    await db.refresh(machine)
    return _line_objective_out(machine)


@router.delete("/assembly-lines/{machine_id}")
async def delete_assembly_line(
    machine_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("settings_machines", "update")),
):
    """Remove an assembly line from the plant (soft): deactivates the Equipment
    and its kiosk/Machine so it drops from the line list, the TV stats and the
    factory map. History (stops, OFs, production) is preserved."""
    machine = ensure_same_plant(await db.get(Machine, machine_id), ctx, detail="Machine not found")
    eq = await db.get(Equipment, machine.equipment_id) if machine.equipment_id else None
    if eq is not None:
        eq.active = False
        await ensure_machine_for_equipment(db, eq)  # turns the kiosk off
    else:
        machine.is_active = False
    await db.commit()
    return {"ok": True}


@router.post("/", response_model=MachineOut, status_code=201)
async def create_machine(
    data: MachineCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # New records are born in the active plant — never inferred from the payload.
    machine = Machine(**data.model_dump(exclude_none=True))
    machine.plant_id = ctx.plant_id
    db.add(machine)
    await db.commit()
    await db.refresh(machine)
    return machine


@router.patch("/{machine_id}", response_model=MachineOut)
async def update_machine(
    machine_id: UUID,
    data: MachinePatch,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = ensure_same_plant(await db.get(Machine, machine_id), ctx, detail="Machine not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(machine, k, v)
    await db.commit()
    await db.refresh(machine)
    return machine


class CloneLayoutIn(BaseModel):
    layout: list = []
    target_ids: List[UUID] = []


@router.post("/clone-layout")
async def clone_kiosk_layout(
    data: CloneLayoutIn,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Copy a kiosk panel layout onto other machines (from the edit-layout view)."""
    if not data.target_ids:
        return {"updated": 0}
    rows = (await db.execute(select(Machine).where(
        Machine.id.in_(data.target_ids), plant_condition(Machine, ctx)
    ))).scalars().all()
    for m in rows:
        m.kiosk_layout = data.layout
    await db.commit()
    return {"updated": len(rows)}


@router.delete("/{machine_id}", status_code=204)
async def delete_machine(
    machine_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = ensure_same_plant(await db.get(Machine, machine_id), ctx, detail="Machine not found")
    machine.is_active = False
    await db.commit()


# ── Machine page (no auth — kiosk mode) ───────────────────────────────────────

@router.get("/{ref}/page", response_model=MachinePageData)
async def machine_page(ref: str, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    closed = [TicketStatus.completed, TicketStatus.cancelled]
    r = await db.execute(
        select(MaintenanceTicket)
        .where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.status.not_in(closed),
        )
        .order_by(MaintenanceTicket.opened_at.desc())
    )
    raw_tickets = r.scalars().all()

    open_tickets = []
    for t in raw_tickets:
        assigned_name = None
        if t.assigned_to_id:
            u = await db.get(User, t.assigned_to_id)
            if u:
                assigned_name = u.name
        wo_number = None
        if t.work_order_id:
            wo = await db.get(WorkOrder, t.work_order_id)
            if wo:
                wo_number = wo.wo_number
        ptype = t.problem_type.value if t.problem_type and hasattr(t.problem_type, "value") else (str(t.problem_type) if t.problem_type else None)
        open_tickets.append(TicketForMachine(
            id=t.id, ticket_number=t.ticket_number,
            status=t.status.value if hasattr(t.status, "value") else str(t.status),
            priority=t.priority.value if hasattr(t.priority, "value") else str(t.priority),
            problem_type=ptype, description=t.description,
            assigned_to_name=assigned_name, opened_at=t.opened_at,
            opened_by_technician_at=t.opened_by_technician_at,
            work_order_id=t.work_order_id, work_order_number=wo_number,
        ))

    return _machine_to_page_data(machine, open_tickets)


# ── Status update ─────────────────────────────────────────────────────────────

@router.patch("/{ref}/status")
async def update_machine_status(
    ref: str,
    data: MachineStatusUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    now = datetime.now(timezone.utc)
    old_status = machine.current_status.value if hasattr(machine.current_status, "value") else str(machine.current_status or "running")

    machine.current_status = data.status
    if data.current_operator is not None:
        machine.current_operator = data.current_operator
    if data.current_shift is not None:
        machine.current_shift = data.current_shift

    new_status = data.status.value if hasattr(data.status, "value") else str(data.status)
    if new_status == MachineStatus.running.value and old_status != MachineStatus.running.value:
        machine.last_start_at = now
    elif new_status != MachineStatus.running.value and old_status == MachineStatus.running.value:
        machine.last_stop_at = now

    await db.commit()
    return {"status": "ok"}


# ── Job number ────────────────────────────────────────────────────────────────

@router.patch("/{ref}/job")
async def update_job_number(
    ref: str,
    data: MachineJobUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    # Scanning the OF here opens a JobOrderRun ("passagem") so its time/cost on this
    # machine is tracked and the OF is located for WIP. An empty value clears it.
    jo, _run = await scan_job_order_at_machine(
        db, machine, data.job_number, source=JobOrderSource.manual,
    )
    await db.commit()
    return {"status": "ok", "job_number": machine.current_job_number,
            "job_order_id": str(jo.id) if jo else None}


# ── Operator selection ────────────────────────────────────────────────────────

@router.patch("/{ref}/operator")
async def update_operator(
    ref: str,
    data: MachineOperatorUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    if data.operator_name is not None:
        machine.current_operator = data.operator_name
    if data.operator_id is not None:
        op = await db.get(MachineOperator, data.operator_id)
        if op:
            machine.current_operator = op.name
    await db.commit()
    return {"status": "ok", "current_operator": machine.current_operator}


# ── Reject counter ────────────────────────────────────────────────────────────

@router.post("/{ref}/rejects")
async def add_rejects(
    ref: str,
    data: MachineRejectUpdate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    shift_str = machine.current_shift.value if machine.current_shift and hasattr(machine.current_shift, "value") else "morning"
    svc = MesService(db)
    new_total = await svc.increment_rejects(machine.id, data.delta, shift_str)
    return {"status": "ok", "reject_count": new_total}


@router.post("/{ref}/reject-logs", status_code=201)
async def log_reject(
    ref: str,
    data: RejectLogCreate,
    db: AsyncSession = Depends(get_db),
):
    """Kiosk: log a reject with category (also increments production_log)."""
    machine = await _get_machine(ref, db)
    shift_str = machine.current_shift.value if machine.current_shift and hasattr(machine.current_shift, "value") else "morning"
    try:
        shift_enum = AlertShift(shift_str)
    except ValueError:
        shift_enum = AlertShift.morning

    log = RejectLog(
        machine_id=machine.id,
        plant_id=machine.plant_id,
        date=date.today(),
        shift=shift_enum,
        job_number=data.job_number or machine.current_job_number,
        reject_category_id=data.reject_category_id,
        reject_subcategory_id=data.reject_subcategory_id,
        quantity=data.quantity,
        comments=data.comments,
    )
    db.add(log)
    svc = MesService(db)
    new_total = await svc.increment_rejects(machine.id, data.quantity, shift_str)
    await db.commit()
    return {"status": "ok", "reject_count": new_total}


@router.get("/{ref}/rejects/today")
async def today_rejects(ref: str, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    today = date.today()
    r = await db.execute(
        select(RejectLog)
        .where(RejectLog.machine_id == machine.id, RejectLog.date == today)
        .order_by(RejectLog.created_at.desc())
    )
    logs = r.scalars().all()
    total = sum(l.quantity for l in logs)
    by_cat: dict = {}
    for l in logs:
        cat_id = str(l.reject_category_id) if l.reject_category_id else "uncategorized"
        by_cat[cat_id] = by_cat.get(cat_id, 0) + l.quantity

    # Resolve names for the events table (category / subcategory / operator).
    cat_ids = {l.reject_category_id for l in logs if l.reject_category_id}
    sub_ids = {l.reject_subcategory_id for l in logs if l.reject_subcategory_id}
    op_ids = {l.operator_id for l in logs if l.operator_id}
    cat_names = dict((await db.execute(
        select(RejectCategory.id, RejectCategory.name).where(RejectCategory.id.in_(cat_ids))
    )).all()) if cat_ids else {}
    sub_names = dict((await db.execute(
        select(RejectSubcategory.id, RejectSubcategory.name).where(RejectSubcategory.id.in_(sub_ids))
    )).all()) if sub_ids else {}
    op_names = dict((await db.execute(
        select(MachineOperator.id, MachineOperator.name).where(MachineOperator.id.in_(op_ids))
    )).all()) if op_ids else {}

    return {
        "total": total,
        "by_category": by_cat,
        "logs": [
            {
                "id": str(l.id),
                "created_at": l.created_at.isoformat() if l.created_at else None,
                "quantity": l.quantity,
                "comments": l.comments,
                "category_id": str(l.reject_category_id) if l.reject_category_id else None,
                "category_name": cat_names.get(l.reject_category_id),
                "subcategory_id": str(l.reject_subcategory_id) if l.reject_subcategory_id else None,
                "subcategory_name": sub_names.get(l.reject_subcategory_id),
                "operator_name": op_names.get(l.operator_id),
            }
            for l in logs
        ],
    }


# ── Production counter ────────────────────────────────────────────────────────

class ProductionUpdate(BaseModel):
    delta: int = 1


@router.post("/{ref}/production")
async def add_production(
    ref: str,
    data: ProductionUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Increment production count for the current shift."""
    machine = await _get_machine(ref, db)
    shift_str = machine.current_shift.value if machine.current_shift and hasattr(machine.current_shift, "value") else "morning"
    try:
        shift_enum = AlertShift(shift_str)
    except ValueError:
        shift_enum = AlertShift.morning

    today = date.today()
    r = await db.execute(
        select(MachineProductionLog).where(
            MachineProductionLog.machine_id == machine.id,
            MachineProductionLog.date == today,
            MachineProductionLog.shift == shift_enum,
        )
    )
    log = r.scalar_one_or_none()
    if not log:
        log = MachineProductionLog(
            machine_id=machine.id,
            plant_id=machine.plant_id,
            date=today,
            shift=shift_enum,
            actual_count=0,
        )
        db.add(log)
    log.actual_count = max(0, (log.actual_count or 0) + data.delta)
    await db.commit()
    await db.refresh(log)
    return {"status": "ok", "production_count": log.actual_count}


# ── Machine stops ─────────────────────────────────────────────────────────────

@router.post("/{ref}/stops", status_code=201)
async def create_stop(
    ref: str,
    data: MachineStopCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create a stop record. If subcategory triggersMaintenance, also creates a ticket."""
    machine = await _get_machine(ref, db)
    now = datetime.now(timezone.utc)

    # A machine has one active stop at a time. Creating a new stop SEGMENTS the
    # downtime: close any currently-open stop first, so "a new stop with another
    # reason" (e.g. justifying a signal-detected stop with a different cause) never
    # double-counts downtime or leaves two overlapping open stops. Maintenance
    # stops with a live ticket are left alone (their own flow owns them).
    open_stops = (await db.execute(
        select(MachineStop).where(
            MachineStop.machine_id == machine.id,
            MachineStop.ended_at.is_(None),
            MachineStop.ticket_id.is_(None),
        )
    )).scalars().all()
    for prev in open_stops:
        prev.ended_at = now
        st = prev.started_at
        if st and st.tzinfo is None:
            st = st.replace(tzinfo=timezone.utc)
        prev.duration_minutes = max(int((now - st).total_seconds() / 60), 0) if st else None

    # Resolve the category type — drives both the maintenance trigger and the machine
    # status color (planned→blue, unplanned→red, maintenance→yellow, none→pink).
    triggers = False
    cat_type = None
    if data.stop_category_id:
        cat = await db.get(StopCategory, data.stop_category_id)
        if cat:
            cat_type = cat.type.value if hasattr(cat.type, "value") else str(cat.type)
    if data.stop_subcategory_id:
        sub = await db.get(StopSubcategory, data.stop_subcategory_id)
        if sub and sub.triggers_maintenance:
            triggers = True
    if not triggers and cat_type == "maintenance":
        triggers = True

    shift_val = None
    if data.shift:
        try:
            shift_val = AlertShift(data.shift)
        except ValueError:
            pass

    stop = MachineStop(
        machine_id=machine.id,
        plant_id=machine.plant_id,
        started_at=now,
        stop_category_id=data.stop_category_id,
        stop_subcategory_id=data.stop_subcategory_id,
        comments=data.comments,
        justified_by=data.justified_by,
        operator_id=data.operator_id,
        shift=shift_val,
        job_number=data.job_number or machine.current_job_number,
    )

    ticket_number = None
    if triggers:
        # A maintenance stop raised from the machine page must surface as an ALERT
        # too (feeds the maintenance dashboard/notifications), not just a ticket —
        # otherwise callMaintenance later adopts this ticket and no alert is ever
        # created. Mirror call_maintenance: alert ↔ ticket linked both ways.
        alert = MaintenanceAlert(
            alert_number=await _next_alert_number(db, machine.plant_id),
            machine_id=machine.id,
            plant_id=machine.plant_id,
            department=machine.department,
            problem_type=AlertProblemType.mechanical,
            priority=AlertPriority.high,
            description=data.comments or "Arrêt maintenance (poste opérateur)",
            created_by=data.justified_by or "operator",
            status=AlertStatus.new_alert,
        )
        db.add(alert)
        await db.flush()
        ticket = MaintenanceTicket(
            ticket_number=await _next_ticket_number(db, machine.plant_id),
            machine_id=machine.id,
            plant_id=machine.plant_id,
            alert_id=alert.id,
            priority=AlertPriority.high,
            problem_type=None,
            description=data.comments,
            machine_page_source=True,
        )
        db.add(ticket)
        await db.flush()
        alert.ticket_id = ticket.id
        stop.ticket_id = ticket.id
        ticket_number = ticket.ticket_number
        machine.current_status = MachineStatus.maintenance
        machine.last_maintenance_at = now

        # Notify the ticket open/close group (level-0 contacts) + technician pool —
        # mirrors request_maintenance/call_maintenance. Without this, a maintenance
        # stop raised from the machine page opened a ticket silently (no SMS/email).
        from app.services.notification_service import NotificationService
        notif = NotificationService(db)
        if ticket.priority == AlertPriority.critical:
            await notif.notify_new_critical(
                ref_number=ticket.ticket_number,
                description=ticket.description,
                machine_name=machine.name,
                alert_id=alert.id,
                ticket_id=ticket.id,
                machine=machine,
            )
        await notif.notify_ticket_opened(ticket, machine.name)
    elif cat_type == "planned":
        machine.current_status = MachineStatus.planned_stop
    elif cat_type is None:
        machine.current_status = MachineStatus.unjustified  # stop with no reason → pink
    else:
        machine.current_status = MachineStatus.stopped       # unplanned → red

    machine.last_stop_at = now
    db.add(stop)
    await db.commit()
    await db.refresh(stop)

    return {
        "id": str(stop.id),
        "started_at": stop.started_at.isoformat(),
        "ticket_number": ticket_number,
        "triggers_maintenance": triggers,
    }


@router.patch("/{ref}/stops/{stop_id}/close")
async def close_stop(
    ref: str,
    stop_id: UUID,
    data: MachineStopClose,
    db: AsyncSession = Depends(get_db),
):
    """Close a stop record and set machine back to running."""
    machine = await _get_machine(ref, db)
    stop = await db.get(MachineStop, stop_id)
    if not stop or stop.machine_id != machine.id:
        raise HTTPException(404, "Stop not found")

    now = datetime.now(timezone.utc)
    stop.ended_at = now
    started = stop.started_at
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    stop.duration_minutes = int((now - started).total_seconds() / 60)

    if data.stop_category_id:
        stop.stop_category_id = data.stop_category_id
    if data.stop_subcategory_id:
        stop.stop_subcategory_id = data.stop_subcategory_id
    if data.comments:
        stop.comments = data.comments
    if data.justified_by:
        stop.justified_by = data.justified_by

    machine.current_status = MachineStatus.running
    machine.last_start_at = now

    await db.commit()
    return {"status": "ok", "duration_minutes": stop.duration_minutes}


# ── Cleaning checklist (kiosk) ────────────────────────────────────────────────
# Operator task list shown when a stop is declared with the linked category
# (e.g. "Nettoyage"). Same trust level as the stop endpoints — no auth.

async def _cleaning_checklist_for_machine(machine: Machine, db: AsyncSession) -> Optional[CleaningChecklist]:
    eq_id = machine.equipment_id
    if not eq_id:
        eq = await db.get(Equipment, machine.id)
        if not eq and machine.code:
            r = await db.execute(select(Equipment).where(Equipment.code == machine.code))
            eq = r.scalar_one_or_none()
        eq_id = eq.id if eq else None
    if not eq_id:
        return None
    r = await db.execute(
        select(CleaningChecklist).where(
            CleaningChecklist.equipment_id == eq_id,
            CleaningChecklist.is_active == True,  # noqa: E712
        ).limit(1)
    )
    return r.scalar_one_or_none()


@router.get("/{ref}/cleaning-checklist")
async def get_cleaning_checklist(ref: str, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    checklist = await _cleaning_checklist_for_machine(machine, db)
    if not checklist:
        return {"checklist": None, "items": []}
    items = (await db.execute(
        select(CleaningChecklistItem)
        .where(CleaningChecklistItem.checklist_id == checklist.id)
        .order_by(CleaningChecklistItem.sort_order)
    )).scalars().all()
    return {
        "checklist": {
            "id": str(checklist.id),
            "name": checklist.name,
            "stop_category_id": str(checklist.stop_category_id) if checklist.stop_category_id else None,
        },
        "items": [
            {"id": str(i.id), "text": i.text, "sort_order": i.sort_order, "is_required": i.is_required}
            for i in items
        ],
    }


@router.get("/{ref}/stops/{stop_id}/cleaning-checklist")
async def get_stop_cleaning_responses(ref: str, stop_id: UUID, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    stop = await db.get(MachineStop, stop_id)
    if not stop or stop.machine_id != machine.id:
        raise HTTPException(404, "Stop not found")
    rows = (await db.execute(
        select(StopCleaningResponse).where(StopCleaningResponse.stop_id == stop_id)
    )).scalars().all()
    return {
        "responses": [
            {
                "item_id": str(r.checklist_item_id) if r.checklist_item_id else None,
                "item_text": r.item_text,
                "checked": r.checked,
                "checked_at": r.checked_at.isoformat() if r.checked_at else None,
                "checked_by": r.checked_by,
            }
            for r in rows
        ]
    }


class CleaningResponseIn(BaseModel):
    item_id: Optional[str] = None
    item_text: str = ""
    checked: bool = False


class CleaningResponsesBody(BaseModel):
    responses: List[CleaningResponseIn]
    checked_by: Optional[str] = None


@router.post("/{ref}/stops/{stop_id}/cleaning-checklist")
async def save_stop_cleaning_responses(
    ref: str,
    stop_id: UUID,
    body: CleaningResponsesBody,
    db: AsyncSession = Depends(get_db),
):
    """Upsert the stop's cleaning-task ticks. The kiosk sends the whole list on
    every toggle, so a lost request never leaves half-saved state; the first
    check keeps its original checked_at."""
    machine = await _get_machine(ref, db)
    stop = await db.get(MachineStop, stop_id)
    if not stop or stop.machine_id != machine.id:
        raise HTTPException(404, "Stop not found")

    existing_rows = (await db.execute(
        select(StopCleaningResponse).where(StopCleaningResponse.stop_id == stop_id)
    )).scalars().all()
    existing = {r.checklist_item_id: r for r in existing_rows}

    now = datetime.now(timezone.utc)
    for resp in body.responses:
        item_id = None
        if resp.item_id:
            try:
                item_id = UUID(resp.item_id)
            except ValueError:
                continue
        row = existing.get(item_id)
        if row:
            if resp.checked and not row.checked:
                row.checked_at = now
                row.checked_by = body.checked_by or row.checked_by
            elif not resp.checked:
                row.checked_at = None
            row.checked = resp.checked
            if resp.item_text:
                row.item_text = resp.item_text
        else:
            db.add(StopCleaningResponse(
                stop_id=stop_id,
                checklist_item_id=item_id,
                item_text=resp.item_text,
                checked=resp.checked,
                checked_at=now if resp.checked else None,
                checked_by=body.checked_by if resp.checked else None,
            ))
    await db.commit()
    return {"status": "ok"}


class ProductionSignalIn(BaseModel):
    running: bool
    ts: Optional[datetime] = None   # reserved: reading timestamp from the gateway


@router.post("/{ref}/signal-token")
async def provision_signal_token(
    ref: str,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Generate (or rotate) the production-signal ingest token for a machine. The
    ADAM-6050 gateway presents it as X-Signal-Token on every reading."""
    machine = await _get_machine_scoped(ref, db, ctx)
    machine.signal_ingest_token = secrets.token_urlsafe(24)
    await db.commit()
    return {"machine_id": str(machine.id), "signal_ingest_token": machine.signal_ingest_token}


@router.post("/{ref}/kiosk-token")
async def provision_kiosk_token(
    ref: str,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Generate (or rotate) the kiosk access token for a machine. Tablets open
    /machines/<slug>?k=<token>; enforced once KIOSK_ENFORCE_TOKEN is on."""
    machine = await _get_machine_scoped(ref, db, ctx)
    machine.kiosk_token = secrets.token_urlsafe(24)
    await db.commit()
    slug = machine.page_slug or str(machine.id)
    return {
        "machine_id": str(machine.id),
        "kiosk_token": machine.kiosk_token,
        "kiosk_url": f"/machines/{slug}?k={machine.kiosk_token}",
    }


@router.post("/{ref}/production-signal")
async def ingest_production_signal(
    ref: str,
    payload: ProductionSignalIn,
    db: AsyncSession = Depends(get_db),
    x_signal_token: Optional[str] = Header(None, alias="X-Signal-Token"),
):
    """Ingest one production-status reading from the machine's I/O (Advantech
    ADAM-6050) and reconcile the live status — the SIGNAL-DRIVEN restart path, no
    operator action. PROVISIONAL auth: per-machine token, like robot cells; the
    real transport (Modbus gateway → HTTP/MQTT) gets wired with the integrator.
    Skeleton for the pilot — no ADAM hardware is connected yet."""
    machine = await _get_machine(ref, db)
    if not machine.signal_ingest_token:
        raise HTTPException(status_code=401, detail="Signal ingest not provisioned for this machine")
    if x_signal_token != machine.signal_ingest_token:
        raise HTTPException(status_code=401, detail="Invalid signal token")
    await apply_production_signal(db, machine, payload.running)
    await db.commit()
    await db.refresh(machine)
    status = machine.current_status.value if hasattr(machine.current_status, "value") else str(machine.current_status)
    return {"machine_id": str(machine.id), "running": payload.running, "status": status}


class ProductionCountIn(BaseModel):
    count: int = 1          # parts produced since the last reading (pulses)
    reject: int = 0         # optional rejects to add
    ts: Optional[datetime] = None


def _shift_bucket(start_hour: int) -> AlertShift:
    """Map a shift's start hour to the shift enum — SAME buckets production_hourly
    uses, so a count lands in the shift the kiosk chart reads back."""
    if 4 <= start_hour < 12:
        return AlertShift.morning
    if 12 <= start_hour < 20:
        return AlertShift.afternoon
    return AlertShift.night


def _wall_clock(ts: Optional[datetime]) -> datetime:
    """Plant-local wall-clock as a naive datetime. The poller/gateway sends its
    LOCAL timestamp (with offset); we read the wall clock as-sent so shift/date
    match what the operator's kiosk shows (its shifts_config is local wall-clock,
    not UTC). Falls back to UTC now when no ts is provided."""
    if ts is None:
        return datetime.now(timezone.utc).replace(tzinfo=None)
    return ts.replace(tzinfo=None)


def _shift_and_date_for(machine, wall: datetime):
    """(shift, date) a wall-clock instant belongs to, per the machine's
    shifts_config windows (local wall-clock, overnight-aware)."""
    cur = wall.hour * 60 + wall.minute
    for cfg in (machine.shifts_config or {}).values():
        if not isinstance(cfg, dict):
            continue
        try:
            sh, sm = [int(x) for x in str(cfg.get("start", "")).split(":")[:2]]
            eh, em = [int(x) for x in str(cfg.get("end", "")).split(":")[:2]]
        except (ValueError, TypeError):
            continue
        s, e = sh * 60 + sm, eh * 60 + em
        if e > s:                                  # same-day window
            if s <= cur < e:
                return _shift_bucket(sh), wall.date()
        else:                                      # overnight window
            if cur >= s:
                return _shift_bucket(sh), wall.date()
            if cur < e:
                return _shift_bucket(sh), wall.date() - timedelta(days=1)
    return AlertShift.morning, wall.date()         # fallback (no window matched)


def _shift_hours(shifts_config) -> tuple[float, int]:
    """(total operating hours/day, shift count) derived from shifts_config,
    overnight-aware. Falls back to 3 shifts × 8h = 24h/day when none configured —
    the platform's default shift pattern."""
    durations: list[float] = []
    for cfg in (shifts_config or {}).values():
        if not isinstance(cfg, dict):
            continue
        try:
            sh, sm = [int(x) for x in str(cfg.get("start", "")).split(":")[:2]]
            eh, em = [int(x) for x in str(cfg.get("end", "")).split(":")[:2]]
        except (ValueError, TypeError):
            continue
        s, e = sh * 60 + sm, eh * 60 + em
        span = (e - s) if e > s else (e + 24 * 60 - s)   # overnight-aware
        if span > 0:
            durations.append(span / 60.0)
    if not durations:
        return 24.0, 3
    return sum(durations), len(durations)


def _derive_targets_from_hourly(per_hour: int, shifts_config) -> tuple[int, int]:
    """(per-shift target, daily target) derived from the master hourly goal:
    per-shift = per_hour × the average shift length; daily = per_hour × total
    operating hours/day — both taken from the machine's configured work shifts."""
    total_h, n = _shift_hours(shifts_config)
    avg_h = total_h / n if n else 8.0
    return round(per_hour * avg_h), round(per_hour * total_h)


@router.post("/{ref}/production-count")
async def ingest_production_count(
    ref: str,
    payload: ProductionCountIn,
    db: AsyncSession = Depends(get_db),
    x_signal_token: Optional[str] = Header(None, alias="X-Signal-Token"),
):
    """Ingest produced-part pulses from the machine's I/O (Advantech ADAM-6051
    counter / DI). Each call adds `count` parts (and optional rejects) to today's
    shift production log, recomputes OEE, and marks the machine running — the
    production-COUNT counterpart of /production-signal (which only sets status).
    Same provisional per-machine token auth (X-Signal-Token)."""
    machine = await _get_machine(ref, db)
    if not machine.signal_ingest_token:
        raise HTTPException(status_code=401, detail="Signal ingest not provisioned for this machine")
    if x_signal_token != machine.signal_ingest_token:
        raise HTTPException(status_code=401, detail="Invalid signal token")

    wall = _wall_clock(payload.ts)
    shift_enum, log_date = _shift_and_date_for(machine, wall)
    # Attribute the parts to the OF currently loaded here (its open JobOrderRun) — the
    # authoritative per-OF count — and get its number to stamp on the OEE/hourly rows.
    job_number = await attribute_production(db, machine.id, payload.count, payload.reject)
    svc = MesService(db)
    totals = await svc.add_production(
        machine.id, payload.count, payload.reject, shift_enum,
        default_target=machine.target_count_per_shift or 480, log_date=log_date,
        job_number=job_number,
    )
    # Record the REAL hour each part was produced (UTC-truncated) so the pieces/hour
    # chart shows the true curve, not a synthetic spread of the shift total.
    ts_aware = payload.ts or datetime.now(timezone.utc)
    if ts_aware.tzinfo is None:
        ts_aware = ts_aware.replace(tzinfo=timezone.utc)
    hour_utc = ts_aware.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    await svc.add_hourly_count(machine.id, hour_utc, payload.count, payload.reject, job_number=job_number)
    # Parts flowing ⇒ the machine is producing: keep the live status green.
    await apply_production_signal(db, machine, True)
    await db.commit()
    production_pulse.record_units(machine.id, payload.count)   # live rate/trend (line TVs)
    return {"machine_id": str(machine.id), "shift": shift_enum.value,
            "date": log_date.isoformat(), **totals}


# ── OF (Ordre de fabrication) external ingest — Cortex + smart-label ───────────
# SKELETONS for the pilot: both events happen at a physical station, so they mirror
# the ADAM /production-signal auth (PROVISIONAL per-machine X-Signal-Token). The real
# transport/contract (Cortex API, label-printer webhook) is wired with the integrator;
# no external system is connected yet. Both funnel through scan_job_order_at_machine so
# an OF scanned via Cortex/smart-label tracks time/cost/WIP exactly like a kiosk scan.

def _require_signal_token(machine, token: Optional[str]) -> None:
    if not machine.signal_ingest_token:
        raise HTTPException(status_code=401, detail="Signal ingest not provisioned for this machine")
    if token != machine.signal_ingest_token:
        raise HTTPException(status_code=401, detail="Invalid signal token")


class OfScanIn(BaseModel):
    job_number: str
    product_name: Optional[str] = None      # from the label, enriches the OF
    target_quantity: Optional[int] = None
    program: Optional[str] = None           # Cortex: cobot program on the label (recorded, never executed)
    ts: Optional[datetime] = None


async def _ingest_of_scan(ref, payload, db, token, source):
    machine = await _get_machine(ref, db)
    _require_signal_token(machine, token)
    jo, run = await scan_job_order_at_machine(
        db, machine, payload.job_number, source=source,
        product_name=payload.product_name, target_quantity=payload.target_quantity,
        when=payload.ts,
    )
    await db.commit()
    return {
        "machine_id": str(machine.id),
        "job_number": machine.current_job_number,
        "job_order_id": str(jo.id) if jo else None,
        "run_id": str(run.id) if run else None,
    }


@router.post("/{ref}/cortex-scan")
async def cortex_scan(
    ref: str,
    payload: OfScanIn,
    db: AsyncSession = Depends(get_db),
    x_signal_token: Optional[str] = Header(None, alias="X-Signal-Token"),
):
    """Cortex label scan at this machine → OF passage (source=cortex). `program` (the
    cobot program read from the label) is recorded/echoed, never executed. Skeleton."""
    return await _ingest_of_scan(ref, payload, db, x_signal_token, JobOrderSource.cortex)


class OfUnitScanIn(BaseModel):
    job_number: str                          # OF number on the finished unit's label
    count: int = 1                           # units this scan represents (normally 1)
    reject: int = 0
    product_name: Optional[str] = None       # from the label, enriches the OF
    target_quantity: Optional[int] = None
    ts: Optional[datetime] = None            # when the unit was scanned (local, with offset)


@router.post("/{ref}/of-unit-scan")
async def of_unit_scan(
    ref: str,
    payload: OfUnitScanIn,
    db: AsyncSession = Depends(get_db),
    x_signal_token: Optional[str] = Header(None, alias="X-Signal-Token"),
):
    """End-of-line unit scan (assembly lines, fed by the Cortex poller): each scan =
    `count` FINISHED unit(s) of the labelled OF leaving this line. Ensures the OF's
    run is open here and credits the units to it (per-OF quantity), AND adds them to
    the line's shift/hourly production (OEE) stamped with that OF — the end-of-line
    twin of /production-count, where the scan itself names the OF instead of
    whatever is loaded. Same provisional per-machine X-Signal-Token auth.

    QUANTITIES ONLY — unlike /production-count this never touches the live status:
    on the lines the belt's ADAM (source=state) is the sole status authority, and
    Cortex scans are PULLED so one can arrive after the belt stopped; painting the
    line green here would stick (the ADAM only reports transitions)."""
    machine = await _get_machine(ref, db)
    _require_signal_token(machine, x_signal_token)
    number = (payload.job_number or "").strip()
    if not number:
        raise HTTPException(status_code=422, detail="job_number_required")

    jo, run = await complete_unit_at_machine(
        db, machine, number, count=payload.count, rejects=payload.reject,
        source=JobOrderSource.cortex, when=payload.ts,
        product_name=payload.product_name, target_quantity=payload.target_quantity,
    )

    # Shift/hourly production + OEE — mirrors /production-count.
    wall = _wall_clock(payload.ts)
    shift_enum, log_date = _shift_and_date_for(machine, wall)
    svc = MesService(db)
    totals = await svc.add_production(
        machine.id, payload.count, payload.reject, shift_enum,
        default_target=machine.target_count_per_shift or 480, log_date=log_date,
        job_number=jo.job_number if jo else None,
    )
    ts_aware = payload.ts or datetime.now(timezone.utc)
    if ts_aware.tzinfo is None:
        ts_aware = ts_aware.replace(tzinfo=timezone.utc)
    hour_utc = ts_aware.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    await svc.add_hourly_count(machine.id, hour_utc, payload.count, payload.reject,
                               job_number=jo.job_number if jo else None)
    await db.commit()
    production_pulse.record_units(machine.id, payload.count)   # live rate/trend (line TVs)
    return {
        "machine_id": str(machine.id),
        "job_number": jo.job_number if jo else None,
        "job_order_id": str(jo.id) if jo else None,
        "run_id": str(run.id) if run else None,
        "run_pieces": run.pieces if run else None,
        "shift": shift_enum.value,
        "date": log_date.isoformat(),
        **totals,
    }


@router.post("/{ref}/smart-label")
async def smart_label_scan(
    ref: str,
    payload: OfScanIn,
    db: AsyncSession = Depends(get_db),
    x_signal_token: Optional[str] = Header(None, alias="X-Signal-Token"),
):
    """Smart-label print at the cutting station → the OF is registered (source=smart_label,
    enriched with product/target from the label) and its first passage opens on this
    machine. Skeleton."""
    return await _ingest_of_scan(ref, payload, db, x_signal_token, JobOrderSource.smart_label)


@router.patch("/{ref}/stops/{stop_id}/reclassify")
async def reclassify_stop(
    ref: str,
    stop_id: UUID,
    data: MachineStopClose,
    db: AsyncSession = Depends(get_db),
):
    """Change the CAUSE of an existing stop (clicked on the kiosk timeline).
    A stop never becomes "running" again here (anti-cheat). CLOSED stops only get
    relabeled — no retroactive tickets. But if the stop is still OPEN and the new
    cause is a maintenance one, this behaves like declaring a maintenance stop:
    alert + ticket + "waiting for mechanic" intervention, mirroring create_stop —
    otherwise the kiosk turns yellow "MAINTENANCE" while nobody was notified."""
    machine = await _get_machine(ref, db)
    stop = await db.get(MachineStop, stop_id)
    if not stop or stop.machine_id != machine.id:
        raise HTTPException(404, "Stop not found")

    stop.stop_category_id = data.stop_category_id
    stop.stop_subcategory_id = data.stop_subcategory_id
    if data.comments is not None:
        stop.comments = data.comments
    if data.justified_by:
        stop.justified_by = data.justified_by

    # Reflect the new cause in the machine's live status only while the stop is open.
    ticket_number = None
    if stop.ended_at is None:
        cat_type = None
        if stop.stop_category_id:
            cat = await db.get(StopCategory, stop.stop_category_id)
            if cat:
                cat_type = cat.type.value if hasattr(cat.type, "value") else str(cat.type)
        triggers = cat_type == "maintenance"
        if not triggers and stop.stop_subcategory_id:
            sub = await db.get(StopSubcategory, stop.stop_subcategory_id)
            triggers = bool(sub and sub.triggers_maintenance)

        if triggers:
            machine.current_status = MachineStatus.maintenance
        elif cat_type == "planned":
            machine.current_status = MachineStatus.planned_stop
        elif cat_type is None:
            machine.current_status = MachineStatus.unjustified
        else:
            machine.current_status = MachineStatus.stopped

        if triggers and stop.ticket_id is None:
            from app.api.routes.machine_operator import _active_intervention, _STATUS_WAITING

            # Skip if a mechanic is already called/on the machine — relabel only.
            if not await _active_intervention(machine.id, db):
                alert = MaintenanceAlert(
                    alert_number=await _next_alert_number(db, machine.plant_id),
                    machine_id=machine.id,
                    plant_id=machine.plant_id,
                    department=machine.department,
                    problem_type=AlertProblemType.mechanical,
                    priority=AlertPriority.high,
                    description=stop.comments or "Arrêt maintenance (poste opérateur)",
                    created_by=stop.justified_by or "operator",
                    status=AlertStatus.new_alert,
                )
                db.add(alert)
                await db.flush()
                ticket = MaintenanceTicket(
                    ticket_number=await _next_ticket_number(db, machine.plant_id),
                    machine_id=machine.id,
                    plant_id=machine.plant_id,
                    alert_id=alert.id,
                    priority=AlertPriority.high,
                    problem_type=None,
                    description=stop.comments,
                    machine_page_source=True,
                )
                db.add(ticket)
                await db.flush()
                alert.ticket_id = ticket.id
                stop.ticket_id = ticket.id
                ticket_number = ticket.ticket_number
                machine.last_maintenance_at = datetime.now(timezone.utc)

                equipment = await db.get(Equipment, machine.id)
                if not equipment and machine.code:
                    equipment = (await db.execute(
                        select(Equipment).where(Equipment.code == machine.code)
                    )).scalar_one_or_none()
                db.add(MachineIntervention(
                    machine_id=machine.id,
                    plant_id=machine.plant_id,
                    equipment_id=equipment.id if equipment else None,
                    ticket_id=ticket.id,
                    status=_STATUS_WAITING,
                    operator_note=stop.comments,
                ))

                from app.services.notification_service import NotificationService
                await NotificationService(db).notify_ticket_opened(ticket, machine.name)

    await db.commit()
    return {"status": "ok", "ticket_number": ticket_number}


def _as_utc(dt: datetime) -> datetime:
    """Treat naive datetimes as UTC (defensive; timestamptz cols are already aware)."""
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


@router.get("/{ref}/stops/today", response_model=List[MachineStopOut])
async def today_stops(
    ref: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Stops for the machine. Defaults to today; pass ISO `start`/`end` to fetch a
    specific window (used by the kiosk timeline's shift navigation, supervisor+)."""
    machine = await _get_machine(ref, db)
    conds = [MachineStop.machine_id == machine.id]
    if start and end:
        try:
            start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
            # Include stops that overlap the window (started before end AND not ended before start)
            conds.append(MachineStop.started_at < end_dt)
            conds.append(
                (MachineStop.ended_at.is_(None)) | (MachineStop.ended_at > start_dt)
            )
        except (ValueError, TypeError):
            conds.append(func.date(MachineStop.started_at) == date.today())
    else:
        conds.append(func.date(MachineStop.started_at) == date.today())
    r = await db.execute(
        select(MachineStop)
        .where(*conds)
        .order_by(MachineStop.started_at)
    )
    stops = r.scalars().all()

    # Interventions for this machine (started ones), matched to stops below by
    # ticket link OR time overlap — the kiosk "start intervention" flow has no ticket.
    now_utc = datetime.now(timezone.utc)
    machine_ivs = (await db.execute(
        select(MachineIntervention).where(
            MachineIntervention.machine_id == machine.id,
            MachineIntervention.started_at.isnot(None),
        )
    )).scalars().all()

    def _iv_for(st: MachineStop) -> Optional[MachineIntervention]:
        if st.ticket_id:
            for iv in machine_ivs:
                if iv.ticket_id == st.ticket_id:
                    return iv
        st_s = _as_utc(st.started_at)
        st_e = _as_utc(st.ended_at) if st.ended_at else now_utc
        match = None
        for iv in machine_ivs:
            iv_s = _as_utc(iv.started_at)
            iv_e = _as_utc(iv.completed_at) if iv.completed_at else now_utc
            if iv_s < st_e and iv_e > st_s and (match is None or iv_s > _as_utc(match.started_at)):
                match = iv
        return match

    # An intervention is "preventive" (→ planned, not downtime) when it comes from a
    # preventive/predictive/inspection work order (via its ticket). Corrective/kiosk
    # interventions (no such WO) are unplanned.
    iv_preventive: dict = {}
    tkt_ids = {iv.ticket_id for iv in machine_ivs if iv.ticket_id}
    if tkt_ids:
        tkt_wo = dict((await db.execute(
            select(MaintenanceTicket.id, MaintenanceTicket.work_order_id).where(MaintenanceTicket.id.in_(tkt_ids))
        )).all())
        wo_ids = {w for w in tkt_wo.values() if w}
        wo_types = dict((await db.execute(
            select(WorkOrder.id, WorkOrder.type).where(WorkOrder.id.in_(wo_ids))
        )).all()) if wo_ids else {}
        planned_types = {WorkOrderType.preventive, WorkOrderType.predictive, WorkOrderType.inspection}
        for iv in machine_ivs:
            wid = tkt_wo.get(iv.ticket_id)
            iv_preventive[iv.id] = bool(wid and wo_types.get(wid) in planned_types)

    result = []
    for s in stops:
        cat_mini = None
        if s.stop_category_id:
            cat = await db.get(StopCategory, s.stop_category_id)
            if cat:
                cat_mini = StopCategoryMini(
                    id=cat.id, name=cat.name, icon=cat.icon, color=cat.color,
                    type=cat.type.value if hasattr(cat.type, "value") else str(cat.type),
                )
        sub_mini = None
        if s.stop_subcategory_id:
            sub = await db.get(StopSubcategory, s.stop_subcategory_id)
            if sub:
                sub_mini = StopSubcategoryMini(
                    id=sub.id, name=sub.name, icon=sub.icon, color=sub.color,
                    triggers_maintenance=sub.triggers_maintenance,
                )
        op_name = None
        if s.operator_id:
            op = await db.get(MachineOperator, s.operator_id)
            if op:
                op_name = op.name
        # Linked intervention timing (for the timeline's wait → purple work split).
        # Matched by ticket OR time overlap (kiosk "start intervention" has no ticket).
        interv_started = interv_completed = wait_min = None
        interv_type = interv_by = None
        interv_preventive = False
        iv = _iv_for(s)
        if iv:
            interv_started = iv.started_at
            interv_completed = iv.completed_at
            wait_min = iv.response_time_minutes
            interv_type = iv.intervention_type_name
            interv_by = iv.started_by_name
            interv_preventive = iv_preventive.get(iv.id, False)
        result.append(MachineStopOut(
            id=s.id, machine_id=s.machine_id,
            started_at=s.started_at, ended_at=s.ended_at,
            duration_minutes=s.duration_minutes,
            comments=s.comments, justified_by=s.justified_by,
            ticket_id=s.ticket_id,
            category=cat_mini, subcategory=sub_mini,
            job_number=s.job_number, operator_name=op_name,
            intervention_started_at=interv_started,
            intervention_completed_at=interv_completed,
            wait_minutes=wait_min,
            intervention_type_name=interv_type,
            intervention_by=interv_by,
            intervention_is_preventive=interv_preventive,
        ))
    return result


# ── MES data (extended) ───────────────────────────────────────────────────────

@router.get("/{ref}/mes-data", response_model=MESDataExtended)
async def mes_data(ref: str, db: AsyncSession = Depends(get_db)):
    machine = await _get_machine(ref, db)
    svc = MesService(db)
    availability = await svc.get_availability(machine.id, date.today())
    downtime_min = await svc.get_today_downtime_minutes(machine.id)

    # Real production for today (across shifts), from machine_production_logs.
    rows = (await db.execute(
        select(MachineProductionLog).where(
            MachineProductionLog.machine_id == machine.id,
            MachineProductionLog.date == date.today(),
        )
    )).scalars().all()
    if rows:
        produced = sum(r.actual_count or 0 for r in rows)
        target = sum(r.target_count or 0 for r in rows) or (machine.target_count or 0)
        rejects = sum(r.reject_count or 0 for r in rows)
        oee = round(sum(r.oee_pct or 0 for r in rows) / len(rows), 1)
        return MESDataExtended(
            production_count=produced, target=target, oee_pct=oee,
            availability_pct=availability, reject_count=rejects,
            downtime_today_minutes=downtime_min, is_placeholder=False,
        )
    # Provisioned for a real signal feed (ADAM) but nothing counted today: that's
    # a real zero, not "MES coming soon" — the placeholder must not come back on
    # days the poller hasn't produced yet.
    if machine.signal_ingest_token:
        return MESDataExtended(
            production_count=0,
            target=machine.target_count or 0,
            oee_pct=0.0,
            availability_pct=availability,
            reject_count=await svc.get_today_rejects(machine.id),
            downtime_today_minutes=downtime_min,
            is_placeholder=False,
        )
    # No production feed at all → keep the placeholder card.
    return MESDataExtended(
        production_count=svc.get_mock_production_count(),
        target=svc.get_mock_target(),
        oee_pct=svc.get_mock_oee(),
        availability_pct=availability,
        reject_count=await svc.get_today_rejects(machine.id),
        downtime_today_minutes=downtime_min,
        is_placeholder=True,
    )


def _derive_hourly(total: int, win_start: datetime, win_end: datetime, now: datetime, seed: int):
    """Spread a shift's production total across its hour buckets with a stable
    (seeded) realistic curve. Hours still in the future (after `now`) read 0.
    Transitional: replace with the real per-hour counter feed (ADAM) later."""
    import random
    h = win_start.replace(minute=0, second=0, microsecond=0)
    buckets = []
    while h < win_end:
        buckets.append(h)
        h = h + timedelta(hours=1)
    if not buckets:
        return []
    rng = random.Random(seed)
    weights = [rng.uniform(0.55, 1.45) for _ in buckets]
    s = sum(weights) or 1.0
    out = []
    for w, b in zip(weights, buckets):
        pieces = round(total * w / s) if b <= now else 0
        out.append({"hour": b.isoformat(), "pieces": max(0, pieces)})
    return out


@router.get("/{ref}/production-hourly")
async def production_hourly(
    ref: str, start: Optional[str] = None, end: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    """Pieces produced per hour for a shift window (defaults to the current shift).
    Derived from the shift's machine_production_logs total."""
    machine = await _get_machine(ref, db)
    now = datetime.now(timezone.utc)
    if start and end:
        win_start = datetime.fromisoformat(start.replace("Z", "+00:00"))
        win_end = datetime.fromisoformat(end.replace("Z", "+00:00"))
    else:
        wins = shift_windows(machine.shifts_config, date.today())
        win_start, win_end = next((w for w in wins if w[0] <= now < w[1]), wins[0])
    if win_start.tzinfo is None:
        win_start = win_start.replace(tzinfo=timezone.utc)
    if win_end.tzinfo is None:
        win_end = win_end.replace(tzinfo=timezone.utc)

    # Match the production log of the shift this window belongs to.
    span_h = (win_end - win_start).total_seconds() / 3600.0
    hour = win_start.hour
    if span_h >= 20:
        shift_enum = None                              # full-day fallback → all shifts
    elif 4 <= hour < 12:
        shift_enum = AlertShift.morning
    elif 12 <= hour < 20:
        shift_enum = AlertShift.afternoon
    else:
        shift_enum = AlertShift.night
    q = select(func.coalesce(func.sum(MachineProductionLog.actual_count), 0)).where(
        MachineProductionLog.machine_id == machine.id,
        MachineProductionLog.date == win_start.date(),
    )
    if shift_enum is not None:
        q = q.where(MachineProductionLog.shift == shift_enum)
    total = int((await db.execute(q)).scalar() or 0)

    # Hourly production goal that drives the target line on the kiosk's "pieces
    # produced" chart. The per-hour target is the master goal set on the machine;
    # legacy machines without it fall back to the old per-shift ÷ shift-length
    # derivation. 0 when nothing is configured (chart hides the line).
    if machine.target_count_per_hour:
        target_per_hour = machine.target_count_per_hour
    else:
        shift_target = machine.target_count_per_shift or machine.target_count or 0
        target_per_hour = round(shift_target / span_h) if span_h > 0 and shift_target else 0

    # REAL per-hour buckets (ADAM feed) within the window. Each part is bucketed by
    # the hour it was actually produced, so the chart shows the true curve.
    real = (await db.execute(
        select(MachineProductionHourly.hour, MachineProductionHourly.count).where(
            MachineProductionHourly.machine_id == machine.id,
            MachineProductionHourly.hour >= win_start,
            MachineProductionHourly.hour < win_end,
        )
    )).all()
    if real:
        by_hour: dict = {}
        for h, c in real:
            hh = h if h.tzinfo else h.replace(tzinfo=timezone.utc)
            key = hh.replace(minute=0, second=0, microsecond=0)
            by_hour[key] = by_hour.get(key, 0) + int(c or 0)
        hours = []
        b = win_start.replace(minute=0, second=0, microsecond=0)
        while b < win_end:
            hours.append({"hour": b.isoformat(), "pieces": by_hour.get(b, 0)})
            b = b + timedelta(hours=1)
        return {"hours": hours, "shift_total": total or sum(by_hour.values()), "target_per_hour": target_per_hour}

    # No real hourly feed (demo/simulated machines) → synthetic spread of the total.
    seed = (machine.id.int + win_start.date().toordinal()) & 0xFFFFFFFF
    return {"hours": _derive_hourly(total, win_start, win_end, now, seed), "shift_total": total, "target_per_hour": target_per_hour}


# ── Machine config ────────────────────────────────────────────────────────────

@router.patch("/{ref}/config")
async def update_config(
    ref: str,
    data: MachineConfigUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = await _get_machine_scoped(ref, db, ctx)
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(machine, k, v)
    # Hourly target is the master production goal: derive the per-shift and daily
    # targets from it + the machine's work shifts, so the whole system (kiosk chart,
    # MES logs, reports) stays consistent with what the operator configured.
    if data.target_count_per_hour is not None:
        per_shift, daily = _derive_targets_from_hourly(
            data.target_count_per_hour, machine.shifts_config)
        machine.target_count_per_shift = per_shift
        machine.target_count = daily
    await db.commit()
    return {"status": "ok"}


# ── Operators ─────────────────────────────────────────────────────────────────

@router.get("/{ref}/operators", response_model=List[MachineOperatorOut])
async def list_operators(
    ref: str,
    shift: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    q = select(MachineOperator).where(
        MachineOperator.machine_id == machine.id,
        MachineOperator.is_active == True,
    )
    if shift:
        from app.models.models import OperatorShift
        q = q.where(
            (MachineOperator.shift == OperatorShift(shift)) |
            (MachineOperator.shift == OperatorShift.all)
        )
    r = await db.execute(q.order_by(MachineOperator.name))
    return r.scalars().all()


@router.post("/{ref}/operators", response_model=MachineOperatorOut, status_code=201)
async def add_operator(
    ref: str,
    data: MachineOperatorCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = await _get_machine_scoped(ref, db, ctx)
    # Child rows inherit the PARENT machine's plant, never the request context.
    op = MachineOperator(machine_id=machine.id, plant_id=machine.plant_id, **data.model_dump())
    db.add(op)
    await db.commit()
    await db.refresh(op)
    return op


@router.patch("/operators/{op_id}", response_model=MachineOperatorOut)
async def update_operator_record(
    op_id: UUID,
    data: OperatorPatch,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    op = ensure_same_plant(await db.get(MachineOperator, op_id), ctx, detail="Operator not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(op, k, v)
    await db.commit()
    await db.refresh(op)
    return op


# ── Request maintenance (legacy endpoint, kept for backwards compat) ──────────

@router.post("/{ref}/request-maintenance", status_code=201)
async def request_maintenance(
    ref: str,
    data: MaintenanceRequestCreate,
    db: AsyncSession = Depends(get_db),
):
    machine = await _get_machine(ref, db)
    ticket = MaintenanceTicket(
        ticket_number=await _next_ticket_number(db, machine.plant_id),
        machine_id=machine.id,
        plant_id=machine.plant_id,
        priority=data.priority,
        problem_type=data.problem_type,
        description=data.description,
        machine_page_source=True,
    )
    db.add(ticket)
    machine.current_status = MachineStatus.maintenance
    if data.operator_name:
        machine.current_operator = data.operator_name
    if data.shift:
        machine.current_shift = data.shift

    from app.services.notification_service import NotificationService
    notif = NotificationService(db)
    await db.flush()
    if data.priority == AlertPriority.critical:
        await notif.notify_new_critical(
            ref_number=ticket.ticket_number,
            description=data.description,
            machine_name=machine.name,
            ticket_id=ticket.id,
            machine=machine,
        )
    await notif.notify_ticket_opened(ticket, machine.name)

    await db.commit()
    await db.refresh(ticket)
    return {
        "ticket_id": str(ticket.id),
        "ticket_number": ticket.ticket_number,
        "machine_name": machine.name,
    }


# ── Per-machine Stop Categories ───────────────────────────────────────────────

def _cat_type_value(cat) -> str:
    return cat.type.value if hasattr(cat.type, "value") else str(cat.type)


@router.get("/{ref}/stop-categories", response_model=List[StopCategoryOut])
async def get_machine_stop_categories(ref: str, db: AsyncSession = Depends(get_db)):
    """Kiosk-accessible: returns machine-specific categories, falls back to global."""
    machine = await _get_machine(ref, db)
    r = await db.execute(
        select(StopCategory)
        .where(StopCategory.machine_id == machine.id, StopCategory.is_active == True)
        .order_by(StopCategory.sort_order)
    )
    cats = r.scalars().all()
    if not cats:
        # Fall back to global templates
        r2 = await db.execute(
            select(StopCategory)
            .where(StopCategory.is_global == True, StopCategory.is_active == True)
            .order_by(StopCategory.sort_order)
        )
        cats = r2.scalars().all()
    result = []
    for c in cats:
        subs_r = await db.execute(
            select(StopSubcategory)
            .where(StopSubcategory.category_id == c.id, StopSubcategory.is_active == True)
            .order_by(StopSubcategory.sort_order)
        )
        subs = subs_r.scalars().all()
        result.append(StopCategoryOut(
            id=c.id, machine_id=c.machine_id, name=c.name,
            name_en=getattr(c, "name_en", None), name_fr=getattr(c, "name_fr", None), name_es=getattr(c, "name_es", None),
            type=c.type, icon=c.icon, color=c.color,
            comment_required=bool(getattr(c, "comment_required", False)),
            triggers_maintenance=bool(getattr(c, "triggers_maintenance", False)),
            is_active=c.is_active if c.is_active is not None else True,
            is_global=bool(getattr(c, "is_global", False)),
            sort_order=c.sort_order,
            subcategories=[StopSubcategoryOut(
                id=s.id, category_id=s.category_id, name=s.name,
                name_en=getattr(s, "name_en", None), name_fr=getattr(s, "name_fr", None), name_es=getattr(s, "name_es", None),
                icon=s.icon, color=s.color,
                comment_required=bool(getattr(s, "comment_required", False)),
                triggers_maintenance=bool(getattr(s, "triggers_maintenance", False)),
                is_active=s.is_active if s.is_active is not None else True, sort_order=s.sort_order,
            ) for s in subs],
        ))
    return result


@router.post("/{ref}/stop-categories", response_model=StopCategoryOut, status_code=201)
async def create_machine_stop_category(
    ref: str,
    data: StopCategoryCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = await _get_machine_scoped(ref, db, ctx)
    cat = StopCategory(machine_id=machine.id, is_global=False, **data.model_dump())
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    return StopCategoryOut(id=cat.id, machine_id=cat.machine_id, name=cat.name,
                           name_en=cat.name_en, name_fr=cat.name_fr, name_es=cat.name_es,
                           type=cat.type, icon=cat.icon, color=cat.color,
                           comment_required=cat.comment_required, triggers_maintenance=cat.triggers_maintenance,
                           is_active=cat.is_active, is_global=cat.is_global, sort_order=cat.sort_order,
                           subcategories=[])


@router.patch("/{ref}/stop-categories/reorder")
async def reorder_machine_stop_categories(
    ref: str, items: List[SortOrderItem],
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    for item in items:
        cat = await db.get(StopCategory, item.id)
        if cat:
            cat.sort_order = item.sort_order
    await db.commit()
    return {"status": "ok"}


@router.patch("/{ref}/stop-categories/{cat_id}", response_model=StopCategoryOut)
async def update_machine_stop_category(
    ref: str, cat_id: UUID, data: StopCategoryUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    cat = await db.get(StopCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Category not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(cat, k, v)
    await db.commit()
    await db.refresh(cat)
    subs_r = await db.execute(select(StopSubcategory).where(StopSubcategory.category_id == cat.id).order_by(StopSubcategory.sort_order))
    subs = subs_r.scalars().all()
    return StopCategoryOut(id=cat.id, machine_id=cat.machine_id, name=cat.name,
                           name_en=cat.name_en, name_fr=cat.name_fr, name_es=cat.name_es,
                           type=cat.type, icon=cat.icon, color=cat.color,
                           comment_required=cat.comment_required, triggers_maintenance=cat.triggers_maintenance,
                           is_active=cat.is_active, is_global=cat.is_global, sort_order=cat.sort_order,
                           subcategories=[StopSubcategoryOut(
                               id=s.id, category_id=s.category_id, name=s.name,
                               name_en=s.name_en, name_fr=s.name_fr, name_es=s.name_es,
                               icon=s.icon, color=s.color, comment_required=s.comment_required,
                               triggers_maintenance=s.triggers_maintenance, is_active=s.is_active, sort_order=s.sort_order,
                           ) for s in subs])


@router.delete("/{ref}/stop-categories/{cat_id}", status_code=204)
async def delete_machine_stop_category(
    ref: str, cat_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    cat = await db.get(StopCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Category not found")
    # Stops keep FK references to their category/subcategories; a hard delete on a
    # category with history raises IntegrityError. Deactivate instead — the list
    # endpoints filter on is_active, so it disappears from the UI either way.
    used = (await db.execute(
        select(MachineStop.id).where(MachineStop.stop_category_id == cat_id).limit(1)
    )).first()
    if not used:
        sub_ids = (await db.execute(
            select(StopSubcategory.id).where(StopSubcategory.category_id == cat_id)
        )).scalars().all()
        if sub_ids:
            used = (await db.execute(
                select(MachineStop.id).where(MachineStop.stop_subcategory_id.in_(sub_ids)).limit(1)
            )).first()
    if used:
        cat.is_active = False
    else:
        await db.delete(cat)
    await db.commit()


@router.post("/{ref}/stop-categories/{cat_id}/subcategories", response_model=StopSubcategoryOut, status_code=201)
async def add_stop_subcategory(
    ref: str, cat_id: UUID, data: StopSubcategoryCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    cat = await db.get(StopCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Category not found")
    sub = StopSubcategory(category_id=cat_id, **data.model_dump())
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return sub


@router.patch("/{ref}/stop-subcategories/{sub_id}", response_model=StopSubcategoryOut)
async def update_stop_subcategory(
    ref: str, sub_id: UUID, data: StopSubcategoryUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    sub = await db.get(StopSubcategory, sub_id)
    if not sub:
        raise HTTPException(404, "Subcategory not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(sub, k, v)
    await db.commit()
    await db.refresh(sub)
    return sub


@router.delete("/{ref}/stop-subcategories/{sub_id}", status_code=204)
async def delete_stop_subcategory(
    ref: str, sub_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    sub = await db.get(StopSubcategory, sub_id)
    if not sub:
        raise HTTPException(404, "Subcategory not found")
    # Same FK concern as categories: subcategories referenced by stop history
    # can't be hard-deleted, so deactivate them instead.
    used = (await db.execute(
        select(MachineStop.id).where(MachineStop.stop_subcategory_id == sub_id).limit(1)
    )).first()
    if used:
        sub.is_active = False
    else:
        await db.delete(sub)
    await db.commit()


# ── Per-machine Reject Categories ─────────────────────────────────────────────

@router.get("/{ref}/reject-categories", response_model=List[RejectCategoryOut])
async def get_machine_reject_categories(ref: str, db: AsyncSession = Depends(get_db)):
    """Kiosk-accessible: returns machine-specific reject categories, falls back to global."""
    machine = await _get_machine(ref, db)
    r = await db.execute(
        select(RejectCategory)
        .where(RejectCategory.machine_id == machine.id, RejectCategory.is_active == True)
        .order_by(RejectCategory.sort_order)
    )
    cats = r.scalars().all()
    if not cats:
        r2 = await db.execute(
            select(RejectCategory)
            .where(RejectCategory.is_global == True, RejectCategory.is_active == True)
            .order_by(RejectCategory.sort_order)
        )
        cats = r2.scalars().all()
    result = []
    for c in cats:
        subs_r = await db.execute(
            select(RejectSubcategory)
            .where(RejectSubcategory.category_id == c.id, RejectSubcategory.is_active == True)
            .order_by(RejectSubcategory.sort_order)
        )
        subs = subs_r.scalars().all()
        result.append(RejectCategoryOut(
            id=c.id, machine_id=c.machine_id, name=c.name,
            name_en=c.name_en, name_fr=c.name_fr, name_es=c.name_es,
            icon=c.icon, color=c.color, comment_required=bool(c.comment_required),
            is_active=c.is_active if c.is_active is not None else True,
            is_global=bool(c.is_global), sort_order=c.sort_order,
            subcategories=[RejectSubcategoryOut(
                id=s.id, category_id=s.category_id, name=s.name,
                name_en=s.name_en, name_fr=s.name_fr, name_es=s.name_es,
                icon=s.icon, color=s.color, comment_required=bool(s.comment_required),
                is_active=s.is_active if s.is_active is not None else True, sort_order=s.sort_order,
            ) for s in subs],
        ))
    return result


@router.post("/{ref}/reject-categories", response_model=RejectCategoryOut, status_code=201)
async def create_machine_reject_category(
    ref: str, data: RejectCategoryCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = await _get_machine_scoped(ref, db, ctx)
    cat = RejectCategory(machine_id=machine.id, is_global=False, **data.model_dump())
    db.add(cat)
    await db.commit()
    await db.refresh(cat)
    return RejectCategoryOut(id=cat.id, machine_id=cat.machine_id, name=cat.name,
                             name_en=cat.name_en, name_fr=cat.name_fr, name_es=cat.name_es,
                             icon=cat.icon, color=cat.color, comment_required=cat.comment_required,
                             is_active=cat.is_active, is_global=cat.is_global, sort_order=cat.sort_order,
                             subcategories=[])


@router.patch("/{ref}/reject-categories/reorder")
async def reorder_machine_reject_categories(
    ref: str, items: List[SortOrderItem],
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    for item in items:
        cat = await db.get(RejectCategory, item.id)
        if cat:
            cat.sort_order = item.sort_order
    await db.commit()
    return {"status": "ok"}


@router.patch("/{ref}/reject-categories/{cat_id}", response_model=RejectCategoryOut)
async def update_machine_reject_category(
    ref: str, cat_id: UUID, data: RejectCategoryUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    cat = await db.get(RejectCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Reject category not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(cat, k, v)
    await db.commit()
    await db.refresh(cat)
    subs_r = await db.execute(select(RejectSubcategory).where(RejectSubcategory.category_id == cat.id).order_by(RejectSubcategory.sort_order))
    subs = subs_r.scalars().all()
    return RejectCategoryOut(id=cat.id, machine_id=cat.machine_id, name=cat.name,
                             name_en=cat.name_en, name_fr=cat.name_fr, name_es=cat.name_es,
                             icon=cat.icon, color=cat.color, comment_required=cat.comment_required,
                             is_active=cat.is_active, is_global=cat.is_global, sort_order=cat.sort_order,
                             subcategories=[RejectSubcategoryOut(
                                 id=s.id, category_id=s.category_id, name=s.name,
                                 name_en=s.name_en, name_fr=s.name_fr, name_es=s.name_es,
                                 icon=s.icon, color=s.color, comment_required=s.comment_required,
                                 is_active=s.is_active, sort_order=s.sort_order,
                             ) for s in subs])


@router.delete("/{ref}/reject-categories/{cat_id}", status_code=204)
async def delete_machine_reject_category(
    ref: str, cat_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    cat = await db.get(RejectCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Reject category not found")
    # Reject logs reference categories/subcategories; keep history intact by
    # deactivating instead of hard-deleting when referenced.
    used = (await db.execute(
        select(RejectLog.id).where(RejectLog.reject_category_id == cat_id).limit(1)
    )).first()
    if not used:
        sub_ids = (await db.execute(
            select(RejectSubcategory.id).where(RejectSubcategory.category_id == cat_id)
        )).scalars().all()
        if sub_ids:
            used = (await db.execute(
                select(RejectLog.id).where(RejectLog.reject_subcategory_id.in_(sub_ids)).limit(1)
            )).first()
    if used:
        cat.is_active = False
    else:
        await db.delete(cat)
    await db.commit()


@router.post("/{ref}/reject-categories/{cat_id}/subcategories", response_model=RejectSubcategoryOut, status_code=201)
async def add_reject_subcategory(
    ref: str, cat_id: UUID, data: RejectSubcategoryCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    cat = await db.get(RejectCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Reject category not found")
    sub = RejectSubcategory(category_id=cat_id, **data.model_dump())
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return sub


@router.patch("/{ref}/reject-subcategories/{sub_id}", response_model=RejectSubcategoryOut)
async def update_reject_subcategory(
    ref: str, sub_id: UUID, data: RejectSubcategoryUpdate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    sub = await db.get(RejectSubcategory, sub_id)
    if not sub:
        raise HTTPException(404, "Reject subcategory not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(sub, k, v)
    await db.commit()
    await db.refresh(sub)
    return sub


@router.delete("/{ref}/reject-subcategories/{sub_id}", status_code=204)
async def delete_reject_subcategory(
    ref: str, sub_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    await _get_machine_scoped(ref, db, ctx)
    sub = await db.get(RejectSubcategory, sub_id)
    if not sub:
        raise HTTPException(404, "Reject subcategory not found")
    used = (await db.execute(
        select(RejectLog.id).where(RejectLog.reject_subcategory_id == sub_id).limit(1)
    )).first()
    if used:
        sub.is_active = False
    else:
        await db.delete(sub)
    await db.commit()


# ── Delete operator ───────────────────────────────────────────────────────────

@router.delete("/operators/{op_id}", status_code=204)
async def delete_operator(
    op_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    op = ensure_same_plant(await db.get(MachineOperator, op_id), ctx, detail="Operator not found")
    await db.delete(op)
    await db.commit()


# ── Clone categories ──────────────────────────────────────────────────────────

@router.post("/clone-categories")
async def clone_categories(
    data: CloneCategoriesRequest,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Clone all stop or reject categories from source machine to target machines."""
    import copy

    # Source and every target must be visible machines — cloning never crosses plants.
    ensure_same_plant(await db.get(Machine, data.source_machine_id), ctx, detail="Machine not found")
    for target_id in data.target_machine_ids:
        ensure_same_plant(await db.get(Machine, target_id), ctx, detail="Machine not found")

    if data.category_type == "stop":
        src_cats_r = await db.execute(
            select(StopCategory).where(StopCategory.machine_id == data.source_machine_id).order_by(StopCategory.sort_order)
        )
        src_cats = src_cats_r.scalars().all()

        for target_id in data.target_machine_ids:
            # Remove existing machine-specific categories on target
            existing_r = await db.execute(select(StopCategory).where(StopCategory.machine_id == target_id))
            for old in existing_r.scalars().all():
                await db.delete(old)

            for src_cat in src_cats:
                new_cat = StopCategory(
                    machine_id=target_id,
                    name=src_cat.name, name_en=src_cat.name_en, name_fr=src_cat.name_fr, name_es=src_cat.name_es,
                    type=src_cat.type, icon=src_cat.icon, color=src_cat.color,
                    comment_required=src_cat.comment_required, triggers_maintenance=src_cat.triggers_maintenance,
                    is_active=src_cat.is_active, is_global=False, sort_order=src_cat.sort_order,
                )
                db.add(new_cat)
                await db.flush()

                subs_r = await db.execute(select(StopSubcategory).where(StopSubcategory.category_id == src_cat.id))
                for sub in subs_r.scalars().all():
                    db.add(StopSubcategory(
                        category_id=new_cat.id,
                        name=sub.name, name_en=sub.name_en, name_fr=sub.name_fr, name_es=sub.name_es,
                        icon=sub.icon, color=sub.color,
                        comment_required=sub.comment_required, triggers_maintenance=sub.triggers_maintenance,
                        is_active=sub.is_active, sort_order=sub.sort_order,
                    ))

    elif data.category_type == "reject":
        src_cats_r = await db.execute(
            select(RejectCategory).where(RejectCategory.machine_id == data.source_machine_id).order_by(RejectCategory.sort_order)
        )
        src_cats = src_cats_r.scalars().all()

        for target_id in data.target_machine_ids:
            existing_r = await db.execute(select(RejectCategory).where(RejectCategory.machine_id == target_id))
            for old in existing_r.scalars().all():
                await db.delete(old)

            for src_cat in src_cats:
                new_cat = RejectCategory(
                    machine_id=target_id,
                    name=src_cat.name, name_en=src_cat.name_en, name_fr=src_cat.name_fr, name_es=src_cat.name_es,
                    icon=src_cat.icon, color=src_cat.color,
                    comment_required=src_cat.comment_required,
                    is_active=src_cat.is_active, is_global=False, sort_order=src_cat.sort_order,
                )
                db.add(new_cat)
                await db.flush()

                subs_r = await db.execute(select(RejectSubcategory).where(RejectSubcategory.category_id == src_cat.id))
                for sub in subs_r.scalars().all():
                    db.add(RejectSubcategory(
                        category_id=new_cat.id,
                        name=sub.name, name_en=sub.name_en, name_fr=sub.name_fr, name_es=sub.name_es,
                        icon=sub.icon, color=sub.color,
                        comment_required=sub.comment_required,
                        is_active=sub.is_active, sort_order=sub.sort_order,
                    ))

    await db.commit()
    return {"status": "ok", "cloned_to": len(data.target_machine_ids)}


# ── Machine History ───────────────────────────────────────────────────────────

@router.get("/{ref}/history")
async def get_machine_history(
    ref: str,
    skip: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    machine = await _get_machine_scoped(ref, db, ctx)
    r = await db.execute(
        select(MachineHistory)
        .where(MachineHistory.machine_id == machine.id)
        .order_by(MachineHistory.occurred_at.desc())
        .offset(skip).limit(limit)
    )
    entries = r.scalars().all()

    result = []
    for e in entries:
        row = {
            "id": str(e.id),
            "event_type": e.event_type,
            "problem_type": e.problem_type,
            "description": e.description,
            "diagnosis": e.diagnosis,
            "corrective_action": e.corrective_action,
            "parts_used": e.parts_used,
            "downtime_minutes": e.downtime_minutes,
            "total_minutes": e.total_minutes,
            "occurred_at": e.occurred_at.isoformat() if e.occurred_at else None,
            "completed_at": e.completed_at.isoformat() if e.completed_at else None,
            "work_order_id": str(e.work_order_id) if e.work_order_id else None,
            "ticket_id": str(e.ticket_id) if e.ticket_id else None,
            "technician_name": None,
        }
        if e.technician_id:
            tech = await db.get(Technician, e.technician_id)
            if tech:
                user = await db.get(User, tech.user_id)
                if user:
                    row["technician_name"] = user.name
        result.append(row)

    total_r = await db.execute(
        select(func.count(MachineHistory.id)).where(MachineHistory.machine_id == machine.id)
    )
    return {"total": total_r.scalar(), "items": result}


@router.get("/{ref}/metrics")
async def get_machine_metrics(
    ref: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
    from app.services.machine_history_service import MachineHistoryService
    svc = MachineHistoryService(db)
    metrics = await svc.get_machine_metrics(machine.id)
    metrics["machine_id"] = str(machine.id)
    metrics["machine_name"] = machine.name
    return metrics
