"""Factory map / digital-twin foundation.

Asset-based: lists production `equipment` for a plant, position lives on the equipment
row, live status comes from the linked `machine` (kiosk). Also serves labelled zones
and an open-ticket flag per asset for the live "control room" view.
"""
import asyncio
from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from uuid import UUID
from jose import jwt, JWTError

from app.db.session import get_db, AsyncSessionLocal
from app.models.models import (
    User, Machine, Plant, Equipment, FactoryZone, MapProp, MaintenanceTicket, TicketStatus,
    RobotCell, RobotCellState,
)

# Live robot-cell run_state → map status (cobots are auxiliary, no Machine layer).
_CELL_RUN_MAP = {"running": "running", "stopped": "stopped", "fault": "maintenance", "idle": "idle"}
from app.core.config import settings
from app.core.security import get_current_user
from app.core.permissions import require_permission

router = APIRouter()

_EQ_STATUS_MAP = {
    "running": "running",
    "in_maintenance": "maintenance",
    "stopped": "stopped",
    "scrapped": "idle",
}
_OPEN_TICKET_STATUSES = [
    TicketStatus.open, TicketStatus.in_progress,
    TicketStatus.on_hold_parts, TicketStatus.on_hold_ext,
]


def _effective_status(base: str, open_ticket: bool) -> str:
    """Map colour priority: a physically stopped machine is red; an open
    maintenance call turns it amber; otherwise keep the live MES status."""
    if base == "stopped":
        return "stopped"
    if base == "maintenance" or open_ticket:
        return "maintenance"
    return base


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
        "pos_x": p.pos_x, "pos_y": p.pos_y, "pos_w": p.pos_w, "pos_h": p.pos_h,
        "rotation_deg": p.rotation_deg, "model_scale": p.model_scale,
        "scale_y": p.scale_y, "scale_z": p.scale_z, "height_3d": p.height_3d,
    }


@router.get("/{plant_id}")
async def get_factory_map(
    plant_id: UUID,
    asset_type: str = Query("production"),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
        raise HTTPException(status_code=404, detail="Plant not found")

    eq_query = select(Equipment).where(Equipment.plant_id == plant_id, Equipment.active == True)
    if asset_type and asset_type != "all":
        eq_query = eq_query.where(Equipment.asset_type == asset_type)
    equipment = (await db.execute(eq_query)).scalars().all()

    machines = (await db.execute(select(Machine))).scalars().all()
    machine_by_eq = {str(m.equipment_id): m for m in machines if m.equipment_id}

    # open ticket per machine (for the live badge)
    open_rows = (await db.execute(
        select(MaintenanceTicket.machine_id, MaintenanceTicket.id, MaintenanceTicket.ticket_number)
        .where(MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES))
    )).all()
    open_by_machine: dict[str, dict] = {}
    for mid, tid, tnum in open_rows:
        if mid and str(mid) not in open_by_machine:
            open_by_machine[str(mid)] = {"id": str(tid), "number": tnum}

    # Live run_state from connected robot cells (cobots are independent of their machine)
    cell_run = dict((await db.execute(
        select(RobotCell.equipment_id, RobotCellState.run_state)
        .join(RobotCellState, RobotCellState.cell_id == RobotCell.id)
    )).all())

    def _own_status(eid, eq_status, machine) -> str:
        """One asset's operational status: machine status > cell run_state > equipment status."""
        if machine and machine.current_status:
            s = machine.current_status.value
        else:
            s = _EQ_STATUS_MAP.get(eq_status or "running", "idle")
        if eid in cell_run and cell_run[eid] in _CELL_RUN_MAP:
            s = _CELL_RUN_MAP[cell_run[eid]]
        return s

    # Parent machines can be outside the current asset_type filter → fetch their status.
    parent_ids = {e.parent_equipment_id for e in equipment if e.parent_equipment_id}
    parent_status: dict = {}
    if parent_ids:
        for pe in (await db.execute(select(Equipment).where(Equipment.id.in_(parent_ids)))).scalars().all():
            parent_status[pe.id] = _own_status(pe.id, pe.status.value if pe.status else None, machine_by_eq.get(str(pe.id)))

    items = []
    for e in equipment:
        m = machine_by_eq.get(str(e.id))
        operator = m.current_operator if (m and m.current_status) else None
        status = _own_status(e.id, e.status.value if e.status else None, m)
        # Parent-machine relationship:
        #  • conveyors (and cobots without live telemetry) follow the machine entirely;
        #  • a cobot WITH telemetry is independent while the machine runs, but STOPS when
        #    its machine is down (maintenance / stopped / planned_stop).
        is_cobot = "cobot" in (e.subtype or "").lower() or e.block_kind == "cobot"
        if e.parent_equipment_id:
            pstat = parent_status.get(e.parent_equipment_id)
            parent_down = pstat in ("stopped", "maintenance", "planned_stop")
            if is_cobot and e.id in cell_run:
                if parent_down:
                    status = pstat
            elif pstat:
                status = pstat
        ticket = open_by_machine.get(str(m.id)) if m else None
        status = _effective_status(status, ticket is not None)
        items.append({
            "id": str(e.id),
            "machine_id": str(m.id) if m else None,
            "page_slug": m.page_slug if m else None,
            "name": e.name,
            "code": e.code,
            "status": status,
            "operator": operator,
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

    return {
        "plant_id": str(plant_id),
        "plant_name": plant.name,
        "floor_plan_url": plant.floor_plan_url,
        "machines": items,
        "zones": [_zone_dict(z) for z in zones],
        "props": [_prop_dict(p) for p in props],
    }


@router.patch("/item/{equipment_id}")
async def update_item_layout(
    equipment_id: UUID,
    data: LayoutUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    e = await db.get(Equipment, equipment_id)
    if not e:
        raise HTTPException(status_code=404, detail="Equipment not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(e, field, value)
    await db.commit()
    return {"ok": True}


@router.patch("/{plant_id}/floor-plan")
async def set_floor_plan(
    plant_id: UUID,
    data: FloorPlanUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
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
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
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
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    z = await db.get(FactoryZone, zone_id)
    if not z:
        raise HTTPException(status_code=404, detail="Zone not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(z, field, value)
    await db.commit()
    return {"ok": True}


@router.delete("/zone/{zone_id}", status_code=204)
async def delete_zone(
    zone_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    z = await db.get(FactoryZone, zone_id)
    if z:
        await db.delete(z)
        await db.commit()


# ── Decorative props (non-tracked blocks) ─────────────────────────────────────
@router.post("/{plant_id}/props")
async def create_prop(
    plant_id: UUID,
    data: PropCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    plant = await db.get(Plant, plant_id)
    if not plant:
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
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    p = await db.get(MapProp, prop_id)
    if not p:
        raise HTTPException(status_code=404, detail="Prop not found")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(p, field, value)
    await db.commit()
    return {"ok": True}


@router.delete("/prop/{prop_id}", status_code=204)
async def delete_prop(
    prop_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("machines", "update")),
):
    p = await db.get(MapProp, prop_id)
    if p:
        await db.delete(p)
        await db.commit()


# ── Live status (WebSocket) ───────────────────────────────────────────────────
async def _status_payload(db: AsyncSession, plant_id) -> list[dict]:
    equipment = (await db.execute(
        select(Equipment).where(Equipment.plant_id == plant_id, Equipment.active == True)
    )).scalars().all()
    machines = (await db.execute(select(Machine))).scalars().all()
    machine_by_eq = {str(m.equipment_id): m for m in machines if m.equipment_id}
    open_rows = (await db.execute(
        select(MaintenanceTicket.machine_id, MaintenanceTicket.id, MaintenanceTicket.ticket_number)
        .where(MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES))
    )).all()
    open_by_machine: dict[str, dict] = {}
    for mid, tid, tnum in open_rows:
        if mid and str(mid) not in open_by_machine:
            open_by_machine[str(mid)] = {"id": str(tid), "number": tnum}
    # Same effective-status logic as GET so the LIVE push follows parent machines too.
    cell_run = dict((await db.execute(
        select(RobotCell.equipment_id, RobotCellState.run_state)
        .join(RobotCellState, RobotCellState.cell_id == RobotCell.id)
    )).all())

    def _own(eid, eqs, mc) -> str:
        if mc and mc.current_status:
            s = mc.current_status.value
        else:
            s = _EQ_STATUS_MAP.get(eqs or "running", "idle")
        if eid in cell_run and cell_run[eid] in _CELL_RUN_MAP:
            s = _CELL_RUN_MAP[cell_run[eid]]
        return s

    parent_ids = {e.parent_equipment_id for e in equipment if e.parent_equipment_id}
    parent_status: dict = {}
    if parent_ids:
        for pe in (await db.execute(select(Equipment).where(Equipment.id.in_(parent_ids)))).scalars().all():
            parent_status[pe.id] = _own(pe.id, pe.status.value if pe.status else None, machine_by_eq.get(str(pe.id)))

    out = []
    for e in equipment:
        m = machine_by_eq.get(str(e.id))
        operator = m.current_operator if (m and m.current_status) else None
        status = _own(e.id, e.status.value if e.status else None, m)
        is_cobot = "cobot" in (e.subtype or "").lower() or e.block_kind == "cobot"
        if e.parent_equipment_id:
            pstat = parent_status.get(e.parent_equipment_id)
            parent_down = pstat in ("stopped", "maintenance", "planned_stop")
            if is_cobot and e.id in cell_run:
                if parent_down:
                    status = pstat
            elif pstat:
                status = pstat
        ticket = open_by_machine.get(str(m.id)) if m else None
        status = _effective_status(status, ticket is not None)
        out.append({
            "id": str(e.id), "status": status, "operator": operator,
            "open_ticket": ticket is not None,
            "open_ticket_id": ticket["id"] if ticket else None,
            "open_ticket_number": ticket["number"] if ticket else None,
        })
    return out


@router.websocket("/ws/{plant_id}")
async def factory_map_ws(websocket: WebSocket, plant_id: UUID, token: str = ""):
    """Pushes live machine status for the plant every few seconds (token via query)."""
    try:
        jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        while True:
            async with AsyncSessionLocal() as db:
                payload = await _status_payload(db, plant_id)
            await websocket.send_json({"machines": payload})
            await asyncio.sleep(4)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
