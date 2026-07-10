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
    User, UserPlant, UserRole, Plant, Equipment, FactoryZone, MapProp,
)

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


# ── Live status (WebSocket) ───────────────────────────────────────────────────
async def _status_payload(db: AsyncSession, plant_id) -> list[dict]:
    equipment = (await db.execute(
        select(Equipment).where(Equipment.plant_id == plant_id, Equipment.active == True)
    )).scalars().all()
    # Same shared snapshot as the GET endpoint so the LIVE push follows parent
    # machines, cobot telemetry and open-ticket badges identically.
    details = await live_details_by_equipment(db, equipment)
    out = []
    for e in equipment:
        la = details[str(e.id)]
        ticket = la.open_ticket
        out.append({
            "id": str(e.id), "status": la.status, "operator": la.operator,
            "technicians": la.technicians,
            "open_ticket": ticket is not None,
            "open_ticket_id": ticket["id"] if ticket else None,
            "open_ticket_number": ticket["number"] if ticket else None,
        })
    return out


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
            await websocket.send_json({"machines": payload})
            await asyncio.sleep(4)
    except WebSocketDisconnect:
        return
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
