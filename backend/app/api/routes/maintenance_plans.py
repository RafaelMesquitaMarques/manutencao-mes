from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID
from typing import Optional
from datetime import datetime
from pydantic import BaseModel

from app.db.session import get_db
from app.models.models import User, MaintenancePlan, Equipment
from app.core.security import get_current_user

router = APIRouter()


class PlanCreate(BaseModel):
    equipment_id: str
    name: str
    description: Optional[str] = None
    trigger_type: str = "calendar"
    interval_days: Optional[int] = None
    interval_hours: Optional[float] = None
    next_execution_at: Optional[datetime] = None


def _plan_dict(plan: MaintenancePlan, eq_name: Optional[str] = None) -> dict:
    return {
        "id": str(plan.id),
        "equipment_id": str(plan.equipment_id),
        "equipment_name": eq_name,
        "name": plan.name,
        "description": plan.description,
        "trigger_type": plan.trigger_type,
        "interval_days": plan.interval_days,
        "interval_hours": plan.interval_hours,
        "last_executed_at": plan.last_executed_at.isoformat() if plan.last_executed_at else None,
        "next_execution_at": plan.next_execution_at.isoformat() if plan.next_execution_at else None,
        "active": plan.active,
    }


@router.get("/")
async def list_maintenance_plans(
    equipment_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    query = (
        select(MaintenancePlan, Equipment.name.label("eq_name"))
        .join(Equipment, MaintenancePlan.equipment_id == Equipment.id)
        .where(MaintenancePlan.active == True)
        .order_by(MaintenancePlan.next_execution_at.nullslast())
    )
    if equipment_id:
        query = query.where(MaintenancePlan.equipment_id == equipment_id)
    result = await db.execute(query)
    rows = result.all()
    return [_plan_dict(plan, eq_name) for plan, eq_name in rows]


@router.post("/", status_code=201)
async def create_maintenance_plan(
    data: PlanCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    eq_result = await db.execute(select(Equipment).where(Equipment.id == UUID(data.equipment_id)))
    eq = eq_result.scalar_one_or_none()
    if not eq:
        raise HTTPException(status_code=404, detail="Equipment not found")

    plan = MaintenancePlan(
        equipment_id=UUID(data.equipment_id),
        name=data.name,
        description=data.description,
        trigger_type=data.trigger_type,
        interval_days=data.interval_days,
        interval_hours=data.interval_hours,
        next_execution_at=data.next_execution_at,
    )
    db.add(plan)
    await db.commit()
    await db.refresh(plan)
    return _plan_dict(plan, eq.name)
