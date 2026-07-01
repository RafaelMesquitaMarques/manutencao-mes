import re
import secrets
from datetime import datetime, timezone, date, timedelta
from uuid import UUID
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.db.session import get_db
from app.models.models import (
    Machine, Equipment, MaintenanceTicket, TicketStatus, WorkOrder,
    User, MachineStatus, AlertPriority,
    MachineStop, MachineOperator, StopCategory, StopSubcategory,
    RejectCategory, RejectSubcategory, RejectLog,
    AlertShift, JobOrder, JobOrderSource, MachineProductionLog, MachineProductionHourly,
    MachineHistory, Technician, MachineIntervention,
    MaintenanceAlert, AlertStatus, AlertProblemType,
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
from app.services.ticket_service import TicketService, _next_ticket_number, _next_alert_number
from app.services.mes_service import MesService, shift_windows
from app.services.intervention_sync import apply_production_signal

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
    current_user: User = Depends(get_current_user),
):
    # Soft-deleted machines (is_active=False, set by DELETE) must not surface in
    # dropdowns/lists — they "no longer exist" to the user. Callers that manage
    # deleted records can opt in with ?include_inactive=true.
    stmt = select(Machine).order_by(Machine.name)
    if not include_inactive:
        stmt = stmt.where(Machine.is_active == True)  # noqa: E712
    r = await db.execute(stmt)
    items = r.scalars().all()
    return MachineListResponse(total=len(items), items=items)


@router.post("/", response_model=MachineOut, status_code=201)
async def create_machine(
    data: MachineCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = Machine(**data.model_dump(exclude_none=True))
    db.add(machine)
    await db.commit()
    await db.refresh(machine)
    return machine


@router.patch("/{machine_id}", response_model=MachineOut)
async def update_machine(
    machine_id: UUID,
    data: MachinePatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = await db.get(Machine, machine_id)
    if not machine:
        raise HTTPException(404, "Machine not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(machine, k, v)
    await db.commit()
    await db.refresh(machine)
    return machine


@router.delete("/{machine_id}", status_code=204)
async def delete_machine(
    machine_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = await db.get(Machine, machine_id)
    if not machine:
        raise HTTPException(404, "Machine not found")
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
    machine.current_job_number = data.job_number
    await db.commit()
    return {"status": "ok", "job_number": machine.current_job_number}


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
    return {"total": total, "by_category": by_cat, "logs": [{"id": str(l.id), "quantity": l.quantity, "category_id": str(l.reject_category_id) if l.reject_category_id else None} for l in logs]}


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
            alert_number=await _next_alert_number(db),
            machine_id=machine.id,
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
            ticket_number=await _next_ticket_number(db),
            machine_id=machine.id,
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


class ProductionSignalIn(BaseModel):
    running: bool
    ts: Optional[datetime] = None   # reserved: reading timestamp from the gateway


@router.post("/{ref}/signal-token")
async def provision_signal_token(
    ref: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate (or rotate) the production-signal ingest token for a machine. The
    ADAM-6050 gateway presents it as X-Signal-Token on every reading."""
    machine = await _get_machine(ref, db)
    machine.signal_ingest_token = secrets.token_urlsafe(24)
    await db.commit()
    return {"machine_id": str(machine.id), "signal_ingest_token": machine.signal_ingest_token}


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
    svc = MesService(db)
    totals = await svc.add_production(
        machine.id, payload.count, payload.reject, shift_enum,
        default_target=machine.target_count_per_shift or 480, log_date=log_date,
    )
    # Record the REAL hour each part was produced (UTC-truncated) so the pieces/hour
    # chart shows the true curve, not a synthetic spread of the shift total.
    ts_aware = payload.ts or datetime.now(timezone.utc)
    if ts_aware.tzinfo is None:
        ts_aware = ts_aware.replace(tzinfo=timezone.utc)
    hour_utc = ts_aware.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    await svc.add_hourly_count(machine.id, hour_utc, payload.count, payload.reject)
    # Parts flowing ⇒ the machine is producing: keep the live status green.
    await apply_production_signal(db, machine, True)
    await db.commit()
    return {"machine_id": str(machine.id), "shift": shift_enum.value,
            "date": log_date.isoformat(), **totals}


@router.patch("/{ref}/stops/{stop_id}/reclassify")
async def reclassify_stop(
    ref: str,
    stop_id: UUID,
    data: MachineStopClose,
    db: AsyncSession = Depends(get_db),
):
    """Change the CAUSE of an existing stop (clicked on the kiosk timeline).
    A stop never becomes "running" again here (anti-cheat) and no maintenance
    ticket is created — this only relabels the stop's category/subcategory. If the
    stop is still ongoing, the machine's live status/color reflects the new cause."""
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
    if stop.ended_at is None:
        cat_type = None
        if stop.stop_category_id:
            cat = await db.get(StopCategory, stop.stop_category_id)
            if cat:
                cat_type = cat.type.value if hasattr(cat.type, "value") else str(cat.type)
        if cat_type == "maintenance":
            machine.current_status = MachineStatus.maintenance
        elif cat_type == "planned":
            machine.current_status = MachineStatus.planned_stop
        elif cat_type is None:
            machine.current_status = MachineStatus.unjustified
        else:
            machine.current_status = MachineStatus.stopped

    await db.commit()
    return {"status": "ok"}


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
        # Linked intervention timing (for the timeline's yellow wait → purple work split).
        interv_started = interv_completed = wait_min = None
        if s.ticket_id:
            iv = (await db.execute(
                select(MachineIntervention)
                .where(MachineIntervention.ticket_id == s.ticket_id)
                .order_by(MachineIntervention.called_at.desc())
                .limit(1)
            )).scalar_one_or_none()
            if iv:
                interv_started = iv.started_at
                interv_completed = iv.completed_at
                wait_min = iv.response_time_minutes
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
    # No production fed yet → keep the placeholder card.
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
        return {"hours": hours, "shift_total": total or sum(by_hour.values())}

    # No real hourly feed (demo/simulated machines) → synthetic spread of the total.
    seed = (machine.id.int + win_start.date().toordinal()) & 0xFFFFFFFF
    return {"hours": _derive_hourly(total, win_start, win_end, now, seed), "shift_total": total}


# ── Machine config ────────────────────────────────────────────────────────────

@router.patch("/{ref}/config")
async def update_config(
    ref: str,
    data: MachineConfigUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(machine, k, v)
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
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
    op = MachineOperator(machine_id=machine.id, **data.model_dump())
    db.add(op)
    await db.commit()
    await db.refresh(op)
    return op


@router.patch("/operators/{op_id}", response_model=MachineOperatorOut)
async def update_operator_record(
    op_id: UUID,
    data: OperatorPatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    op = await db.get(MachineOperator, op_id)
    if not op:
        raise HTTPException(404, "Operator not found")
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
        ticket_number=await _next_ticket_number(db),
        machine_id=machine.id,
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
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
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
    current_user: User = Depends(get_current_user),
):
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
    current_user: User = Depends(get_current_user),
):
    await _get_machine(ref, db)
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
    current_user: User = Depends(get_current_user),
):
    cat = await db.get(StopCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Category not found")
    await db.delete(cat)
    await db.commit()


@router.post("/{ref}/stop-categories/{cat_id}/subcategories", response_model=StopSubcategoryOut, status_code=201)
async def add_stop_subcategory(
    ref: str, cat_id: UUID, data: StopSubcategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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
    current_user: User = Depends(get_current_user),
):
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
    current_user: User = Depends(get_current_user),
):
    sub = await db.get(StopSubcategory, sub_id)
    if not sub:
        raise HTTPException(404, "Subcategory not found")
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
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
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
    current_user: User = Depends(get_current_user),
):
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
    current_user: User = Depends(get_current_user),
):
    await _get_machine(ref, db)
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
    current_user: User = Depends(get_current_user),
):
    cat = await db.get(RejectCategory, cat_id)
    if not cat:
        raise HTTPException(404, "Reject category not found")
    await db.delete(cat)
    await db.commit()


@router.post("/{ref}/reject-categories/{cat_id}/subcategories", response_model=RejectSubcategoryOut, status_code=201)
async def add_reject_subcategory(
    ref: str, cat_id: UUID, data: RejectSubcategoryCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
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
    current_user: User = Depends(get_current_user),
):
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
    current_user: User = Depends(get_current_user),
):
    sub = await db.get(RejectSubcategory, sub_id)
    if not sub:
        raise HTTPException(404, "Reject subcategory not found")
    await db.delete(sub)
    await db.commit()


# ── Delete operator ───────────────────────────────────────────────────────────

@router.delete("/operators/{op_id}", status_code=204)
async def delete_operator(
    op_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    op = await db.get(MachineOperator, op_id)
    if not op:
        raise HTTPException(404, "Operator not found")
    await db.delete(op)
    await db.commit()


# ── Clone categories ──────────────────────────────────────────────────────────

@router.post("/clone-categories")
async def clone_categories(
    data: CloneCategoriesRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Clone all stop or reject categories from source machine to target machines."""
    import copy

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
    current_user: User = Depends(get_current_user),
):
    machine = await _get_machine(ref, db)
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
