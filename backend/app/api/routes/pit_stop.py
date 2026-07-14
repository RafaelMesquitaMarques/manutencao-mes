"""Pit Stop endpoints — the buffer zone between fabrication and the assembly lines.

  GET  /{plant_id}/state   read model the 3D map polls (~15 s) — plant members only
  POST /{plant_id}/ingest  one in/out movement; SAP feed later, simulator today.
                           Machine-to-machine auth: X-Signal-Token must match the
                           zone's specifications.ingest_token (assumed contract —
                           see docs/pit-stop-sap-contract.md).
  PATCH /of/{job_order_id} manual actions (priority / hold / release) — pit_stop:update
"""
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.core.permissions import require_permission
from app.core.plant_context import PlantContext, get_plant_context
from app.core.plant_scope import ensure_same_plant
from app.models.models import JobOrder, PitStopDirection, PitStopHoldKind, PitStopSource, User
from app.services.pit_stop_service import (
    compute_state, get_or_create_state, get_pit_stop_equipment, ingest_movement,
)

router = APIRouter()


@router.get("/{plant_id}/state")
async def pit_stop_state(
    plant_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Everything the map needs to draw the buffer: config, categories, the OFs
    physically present (state/completeness/positions/components) and the KPIs.
    Same access rule as the factory-map GET (plant membership)."""
    if not ctx.can_access(plant_id):
        raise HTTPException(status_code=404, detail="Plant not found")
    state = await compute_state(db, plant_id)
    if state is None:
        raise HTTPException(status_code=404, detail="pit_stop_not_configured")
    return state


class PitStopMovementIn(BaseModel):
    """Assumed SAP movement payload (docs/pit-stop-sap-contract.md) — to be
    validated with the SAP team before the real integration is wired."""
    job_number: str
    component_code: str
    direction: str                        # "in" | "out"
    quantity: int = 1
    position_code: Optional[str] = None   # SAP/HANA storage address (free text)
    destination: Optional[str] = None     # machine id / code / kiosk slug (on "out")
    occurred_at: Optional[datetime] = None


@router.post("/{plant_id}/ingest", status_code=201)
async def pit_stop_ingest(
    plant_id: UUID,
    payload: PitStopMovementIn,
    db: AsyncSession = Depends(get_db),
    x_signal_token: Optional[str] = Header(None, alias="X-Signal-Token"),
):
    eq = await get_pit_stop_equipment(db, plant_id)
    if eq is None:
        raise HTTPException(status_code=404, detail="pit_stop_not_configured")
    spec = eq.specifications if isinstance(eq.specifications, dict) else {}
    expected = spec.get("ingest_token")
    if not expected:
        raise HTTPException(status_code=401, detail="Ingest not provisioned for this pit stop")
    if x_signal_token != expected:
        raise HTTPException(status_code=401, detail="Invalid signal token")

    number = (payload.job_number or "").strip()
    code = (payload.component_code or "").strip()
    if not number:
        raise HTTPException(status_code=422, detail="job_number_required")
    if not code:
        raise HTTPException(status_code=422, detail="component_code_required")
    try:
        direction = PitStopDirection(payload.direction)
    except ValueError:
        raise HTTPException(status_code=422, detail="direction_must_be_in_or_out")

    mv = await ingest_movement(
        db, plant_id,
        job_number=number,
        component_code=code,
        direction=direction,
        quantity=payload.quantity,
        position_code=payload.position_code,
        destination=payload.destination,
        occurred_at=payload.occurred_at,
        source=PitStopSource.sap,
        raw=payload.model_dump(mode="json"),
    )
    await db.commit()
    return {
        "movement_id": str(mv.id),
        "job_order_id": str(mv.job_order_id),
        "direction": mv.direction.value,
        "quantity": mv.quantity,
        "anomaly": mv.anomaly,
    }


class PitStopOfPatch(BaseModel):
    """Manual buffer actions. Only the provided fields are applied:
    priority (null clears), hold_kind (null clears, + optional reason),
    released true/false (sets/clears released_at)."""
    priority: Optional[int] = None
    hold_kind: Optional[str] = None       # "hold" | "quality" | "rework" | null
    hold_reason: Optional[str] = None
    released: Optional[bool] = None


@router.patch("/of/{job_order_id}")
async def patch_pit_stop_of(
    job_order_id: UUID,
    data: PitStopOfPatch,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    user: User = Depends(require_permission("pit_stop", "update")),
):
    jo = await db.get(JobOrder, job_order_id)
    if not jo or jo.plant_id is None:
        raise HTTPException(status_code=404, detail="Job order not found")
    ensure_same_plant(jo, ctx, detail="Job order not found")
    st = await get_or_create_state(db, jo.id, jo.plant_id)

    fields = data.model_dump(exclude_unset=True)
    if "priority" in fields:
        st.priority = fields["priority"]
    if "hold_kind" in fields:
        if fields["hold_kind"] is None:
            st.hold_kind = None
            st.hold_reason = None
        else:
            try:
                st.hold_kind = PitStopHoldKind(fields["hold_kind"])
            except ValueError:
                raise HTTPException(status_code=422, detail="invalid_hold_kind")
            st.hold_reason = (fields.get("hold_reason") or "").strip() or None
    elif "hold_reason" in fields and st.hold_kind is not None:
        st.hold_reason = (fields["hold_reason"] or "").strip() or None
    if "released" in fields:
        if fields["released"]:
            st.released_at = datetime.now(timezone.utc)
            st.released_by_id = user.id
        else:
            st.released_at = None
            st.released_by_id = None

    await db.commit()
    return {
        "ok": True,
        "job_order_id": str(jo.id),
        "priority": st.priority,
        "hold_kind": st.hold_kind.value if st.hold_kind else None,
        "hold_reason": st.hold_reason,
        "released_at": st.released_at.isoformat() if st.released_at else None,
    }
