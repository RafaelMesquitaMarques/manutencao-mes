from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, and_
from datetime import datetime, timedelta, timezone

from app.db.session import get_db
from app.models.models import (
    WorkOrder, WorkOrderStatus, WorkOrderType,
    Equipment, LaborRecord, WOCost, User,
)
from app.core.security import get_current_user

router = APIRouter()


@router.get("/summary")
async def get_kpi_summary(
    period_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    since = datetime.now(timezone.utc) - timedelta(days=period_days)

    mttr_r = await db.execute(
        select(func.avg(WorkOrder.repair_hours)).where(
            and_(
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.repair_hours.isnot(None),
            )
        )
    )
    mttr = mttr_r.scalar() or 0.0

    backlog_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress])
        )
    )
    backlog = backlog_r.scalar() or 0

    total_pm_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(WorkOrder.type == WorkOrderType.preventive, WorkOrder.opened_at >= since)
        )
    )
    total_pm = total_pm_r.scalar() or 0

    on_time_r = await db.execute(
        select(func.count(WorkOrder.id)).where(
            and_(
                WorkOrder.type == WorkOrderType.preventive,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.opened_at >= since,
                WorkOrder.completed_at.isnot(None),
                WorkOrder.due_date.isnot(None),
                WorkOrder.completed_at <= WorkOrder.due_date,
            )
        )
    )
    on_time = on_time_r.scalar() or 0
    pm_compliance = round((on_time / total_pm * 100) if total_pm > 0 else 0.0, 1)

    cost_r = await db.execute(
        select(func.sum(WOCost.amount)).where(WOCost.date >= since.date())
    )
    total_cost = cost_r.scalar() or 0.0

    return {
        "mttr_hours": round(float(mttr), 2),
        "backlog_count": int(backlog),
        "pm_compliance_pct": pm_compliance,
        "total_cost_cad": round(float(total_cost), 2),
        "period_days": period_days,
    }


@router.get("/backlog")
async def get_backlog(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(WorkOrder.id, WorkOrder.opened_at).where(
            WorkOrder.status.in_([WorkOrderStatus.open, WorkOrderStatus.in_progress])
        )
    )
    rows = result.all()
    buckets = {"0_7": 0, "7_30": 0, "30_plus": 0}
    for row in rows:
        opened = row.opened_at.replace(tzinfo=None) if row.opened_at.tzinfo else row.opened_at
        age = (now - opened).days
        if age <= 7:
            buckets["0_7"] += 1
        elif age <= 30:
            buckets["7_30"] += 1
        else:
            buckets["30_plus"] += 1

    return {
        "total": len(rows),
        "buckets": [
            {"label": "0–7 days", "count": buckets["0_7"]},
            {"label": "7–30 days", "count": buckets["7_30"]},
            {"label": "30+ days", "count": buckets["30_plus"]},
        ],
    }


@router.get("/mttr")
async def get_mttr_by_equipment(
    period_days: int = Query(90, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    since = datetime.now(timezone.utc) - timedelta(days=period_days)
    result = await db.execute(
        select(
            Equipment.name,
            Equipment.code,
            func.avg(WorkOrder.repair_hours).label("avg_repair"),
            func.count(WorkOrder.id).label("cnt"),
        )
        .join(WorkOrder, WorkOrder.equipment_id == Equipment.id)
        .where(
            and_(
                WorkOrder.type == WorkOrderType.corrective,
                WorkOrder.status == WorkOrderStatus.completed,
                WorkOrder.completed_at >= since,
                WorkOrder.repair_hours.isnot(None),
            )
        )
        .group_by(Equipment.id, Equipment.name, Equipment.code)
        .order_by(func.avg(WorkOrder.repair_hours).desc())
    )
    rows = result.all()
    return [
        {
            "equipment": row.name,
            "code": row.code,
            "avg_repair_hours": round(float(row.avg_repair), 2),
            "repairs": int(row.cnt),
        }
        for row in rows
    ]


@router.get("/cost")
async def get_cost_by_type(
    period_days: int = Query(30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    since = datetime.now(timezone.utc) - timedelta(days=period_days)
    result = await db.execute(
        select(WOCost.transaction_type, func.sum(WOCost.amount).label("total"))
        .where(WOCost.date >= since.date())
        .group_by(WOCost.transaction_type)
    )
    rows = result.all()
    return [{"type": row.transaction_type, "total": round(float(row.total), 2)} for row in rows]
