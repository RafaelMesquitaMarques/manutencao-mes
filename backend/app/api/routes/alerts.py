from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import Optional
from uuid import UUID

from app.db.session import get_db
from app.models.models import MaintenanceAlert, MaintenanceTicket, Machine, Equipment, User, AlertStatus, AlertPriority
from app.schemas.maintenance import (
    AlertCreate, AlertOut, AlertListResponse,
    MachineOut, MachineListResponse,
)
from app.services.alert_service import AlertService
from app.core.security import get_current_user
from app.core.permissions import require_permission
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant, plant_scoped

router = APIRouter()


async def _enrich(alert: MaintenanceAlert, db: AsyncSession) -> AlertOut:
    data = AlertOut.model_validate(alert)
    machine = await db.get(Machine, alert.machine_id)
    if machine:
        data.machine_name = machine.name
    if alert.assigned_to_id:
        user = await db.get(User, alert.assigned_to_id)
        if user:
            data.assigned_to_name = user.name
    # ticket_id: prefer the direct FK on the alert; fall back to reverse lookup for legacy alerts
    if not data.ticket_id:
        r = await db.execute(
            select(MaintenanceTicket.id).where(MaintenanceTicket.alert_id == alert.id)
        )
        row = r.scalar_one_or_none()
        if row:
            data.ticket_id = row
    return data


# ── Machines lookup ────────────────────────────────────────────────────────────

@router.get("/machines", response_model=MachineListResponse)
async def list_machines(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    # Exclude auxiliary (non-productive) equipment — they have no kiosk/MES layer
    aux_ids = set((await db.execute(
        select(Equipment.id).where(Equipment.asset_type == "auxiliary")
    )).scalars().all())
    rows = (await db.execute(plant_scoped(
        select(Machine).where(Machine.is_active == True).order_by(Machine.name),  # noqa: E712
        Machine, ctx,
    ))).scalars().all()
    items = [m for m in rows if m.id not in aux_ids and m.equipment_id not in aux_ids]
    return MachineListResponse(total=len(items), items=items)


# ── Alerts CRUD ────────────────────────────────────────────────────────────────

@router.post("/", response_model=AlertOut, status_code=201)
async def create_alert(
    data: AlertCreate,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("alerts", "create")),
):
    # Relational guard: the target machine must be visible to this user —
    # a crafted machine_id from another plant gets the same 404 as a bogus one.
    ensure_same_plant(await db.get(Machine, data.machine_id), ctx, detail="Machine not found")
    svc = AlertService(db)
    try:
        alert = await svc.create_alert(data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return await _enrich(alert, db)


@router.get("/", response_model=AlertListResponse)
async def list_alerts(
    machine_id:       Optional[UUID]          = None,
    priority:         Optional[AlertPriority] = None,
    status:           Optional[AlertStatus]   = None,
    assigned_to_id:   Optional[UUID]          = None,
    department:       Optional[str]           = None,
    overdue_only:     bool                    = False,
    include_resolved: bool                    = False,
    skip:             int                     = Query(0, ge=0),
    limit:            int                     = Query(100, le=500),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    svc  = AlertService(db)
    rows = await svc.get_alerts(
        machine_id=machine_id,
        priority=priority,
        status=status,
        assigned_to_id=assigned_to_id,
        department=department,
        overdue_only=overdue_only,
        include_resolved=include_resolved,
        plant_ids=[ctx.plant_id],
    )
    total = len(rows)
    page  = rows[skip : skip + limit]
    items = [await _enrich(a, db) for a in page]
    return AlertListResponse(total=total, items=items)


@router.get("/{alert_id}", response_model=AlertOut)
async def get_alert(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    alert = ensure_same_plant(await db.get(MaintenanceAlert, alert_id), ctx, detail="Alert not found")
    return await _enrich(alert, db)


@router.delete("/{alert_id}", status_code=204)
async def delete_alert(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("alerts", "delete")),
):
    alert = ensure_same_plant(await db.get(MaintenanceAlert, alert_id), ctx, detail="Alert not found")
    await db.delete(alert)
    await db.commit()


@router.patch("/{alert_id}/assign", response_model=AlertOut)
async def assign_alert(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("alerts", "update")),
):
    ensure_same_plant(await db.get(MaintenanceAlert, alert_id), ctx, detail="Alert not found")
    svc = AlertService(db)
    try:
        alert = await svc.assign_alert(alert_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return await _enrich(alert, db)


@router.patch("/{alert_id}/convert", response_model=dict)
async def convert_to_ticket(
    alert_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
    _perm: User = Depends(require_permission("alerts", "update")),
):
    ensure_same_plant(await db.get(MaintenanceAlert, alert_id), ctx, detail="Alert not found")
    svc = AlertService(db)
    try:
        ticket = await svc.convert_to_ticket(alert_id, current_user.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ticket_id": str(ticket.id), "ticket_number": ticket.ticket_number}
