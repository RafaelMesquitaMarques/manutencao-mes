"""Robot-cell (FANUC CRX) endpoints.

- Config/register/list/get: authenticated MES users (cells are EXISTING equipment).
- Telemetry ingestion: provisional per-cell token (X-Cell-Token). The real
  transport + auth (HTTP/MQTT/OPC UA) gets wired to ingest_telemetry() later —
  this endpoint is one entry point, not the whole story.

Read-only: there is no endpoint to command the robot, reset safety or move a gate.
"""
import secrets
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.models import (
    User, Equipment, RobotCell, RobotCellState, RobotCellAlarm,
)
from app.core.security import get_current_user
from app.core.permissions import require_permission
from app.schemas.robot_cell import (
    CellTelemetry, RobotCellUpsert, RobotCellConfigOut, RobotCellStateOut, RobotCellOut,
)
from app.services.robot_cell_ingest import ingest_telemetry

router = APIRouter()


async def _active_alarm_count(db: AsyncSession, cell_id) -> int:
    return (await db.execute(
        select(func.count(RobotCellAlarm.id)).where(
            RobotCellAlarm.cell_id == cell_id, RobotCellAlarm.active == True
        )
    )).scalar() or 0


async def _to_out(db: AsyncSession, cell: RobotCell, eq_name: Optional[str]) -> RobotCellOut:
    state = (await db.execute(
        select(RobotCellState).where(RobotCellState.cell_id == cell.id)
    )).scalar_one_or_none()
    return RobotCellOut(
        equipment_id=cell.equipment_id,
        equipment_name=eq_name,
        config=RobotCellConfigOut.model_validate(cell),
        state=RobotCellStateOut.model_validate(state) if state else None,
        active_alarms=await _active_alarm_count(db, cell.id),
    )


@router.get("/", response_model=List[RobotCellOut])
async def list_cells(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(RobotCell, Equipment.name).join(Equipment, RobotCell.equipment_id == Equipment.id)
    )).all()
    return [await _to_out(db, cell, name) for cell, name in rows]


@router.get("/{equipment_id}", response_model=RobotCellOut)
async def get_cell(
    equipment_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    cell = (await db.execute(
        select(RobotCell).where(RobotCell.equipment_id == equipment_id)
    )).scalar_one_or_none()
    if not cell:
        raise HTTPException(status_code=404, detail="Cell not configured for this equipment")
    eq = await db.get(Equipment, equipment_id)
    return await _to_out(db, cell, eq.name if eq else None)


@router.post("/", response_model=RobotCellConfigOut)
async def upsert_cell(
    data: RobotCellUpsert,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _perm: User = Depends(require_permission("equipment", "update")),
):
    """Attach (or update) robot-cell config to an EXISTING equipment."""
    eq = await db.get(Equipment, data.equipment_id)
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")
    cell = (await db.execute(
        select(RobotCell).where(RobotCell.equipment_id == data.equipment_id)
    )).scalar_one_or_none()
    fields = data.model_dump(exclude={"equipment_id"})
    if cell is None:
        cell = RobotCell(equipment_id=data.equipment_id, ingest_token=secrets.token_urlsafe(24), **fields)
        db.add(cell)
    else:
        for k, v in fields.items():
            setattr(cell, k, v)
    await db.commit()
    await db.refresh(cell)
    return RobotCellConfigOut.model_validate(cell)


@router.post("/{equipment_id}/telemetry")
async def push_telemetry(
    equipment_id: str,
    payload: CellTelemetry,
    db: AsyncSession = Depends(get_db),
    x_cell_token: Optional[str] = Header(None, alias="X-Cell-Token"),
):
    """Ingest one telemetry frame for a cell. PROVISIONAL auth: per-cell token.
    Real transport/auth gets decided with the integrator and wired to the same
    ingest_telemetry() service."""
    cell = (await db.execute(
        select(RobotCell).where(RobotCell.equipment_id == equipment_id)
    )).scalar_one_or_none()
    if not cell:
        raise HTTPException(status_code=404, detail="Cell not configured for this equipment")
    if cell.ingest_token and x_cell_token != cell.ingest_token:
        raise HTTPException(status_code=401, detail="Invalid cell token")
    await ingest_telemetry(db, cell, payload)
    return {"ok": True}
