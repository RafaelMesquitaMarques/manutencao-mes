"""Central plant-scoping helpers (multi-plant phase 2).

Every read path filters through these — no hand-written per-route plant
conditions. Two scoping modes:

- PLANT-scoped (default): a row belongs to exactly the active plant
  (`ctx.plant_id`). Machines, tickets, alerts, work orders, stops, PMs, costs…
- GROUP-scoped: inventory and suppliers pool across the active plant's group
  (SJ+Mirabel = 'QC', business decision 2026-07-10); an ungrouped plant
  (Las Vegas) is its own group and sees only itself.

Rows with plant_id NULL are HIDDEN (fail closed): after the phase-1 backfill
every operational table is fully assigned, so a NULL is either brand-new
pre-heal data or an ambiguity — never something to show cross-plant.

Detail routes return 404 for wrong-plant records (never 403 — a plant must not
be able to confirm that another plant's record id exists).
"""
import uuid

from fastapi import Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plant_context import PlantContext, get_plant_context
from app.db.session import get_db
from app.models.models import StockItem, Supplier, Technician, User, UserPlant, UserRole

# Models whose rows pool across the plant group instead of a single plant.
GROUP_SCOPED = (StockItem, Supplier)


def _scope_ids(model, ctx: PlantContext):
    return ctx.group_plant_ids if isinstance(model, type) and issubclass(model, GROUP_SCOPED) else (ctx.plant_id,)


def plant_scoped(stmt, model, ctx: PlantContext):
    """Append the plant condition for `model` to a Select. Usage:
    `stmt = plant_scoped(select(Machine), Machine, ctx)`."""
    return stmt.where(model.plant_id.in_(_scope_ids(model, ctx)))


def plant_condition(model, ctx: PlantContext):
    """The bare SQLAlchemy condition, for queries composed with and_/or joins."""
    return model.plant_id.in_(_scope_ids(model, ctx))


def ensure_same_plant(obj, ctx: PlantContext, *, grouped: bool = False, detail: str = "Not found"):
    """404 a detail-route object that is missing or owned by a plant the user
    cannot see. `grouped=True` widens the check to the active plant's group
    (stock items, suppliers). Visibility for details is by MEMBERSHIP (any
    allowed plant), not just the active one — switching context must not 404
    records the user could legitimately open under their other plant."""
    plant_id = getattr(obj, "plant_id", None) if obj is not None else None
    visible = obj is not None and (
        ctx.can_access_grouped(plant_id) if grouped else ctx.can_access(plant_id)
    )
    if not visible:
        raise HTTPException(status_code=404, detail=detail)
    return obj


def path_plant_guard(model, param: str, *, grouped: bool = False, detail: str = "Not found"):
    """Router-level dependency: when the request path carries `param` (a record
    id of `model`), verify the record's plant is visible to the caller — one
    declaration covers every member route of the router, present and future.
    Routes without the param (collection root, /dashboard, …) pass through and
    scope their own queries. Non-UUID values pass through to the endpoint's own
    validation (422/404)."""
    async def _guard(
        request: Request,
        ctx: PlantContext = Depends(get_plant_context),
        db: AsyncSession = Depends(get_db),
    ) -> None:
        raw = request.path_params.get(param)
        if not raw:
            return
        try:
            record_id = uuid.UUID(raw)
        except (ValueError, AttributeError):
            return
        ensure_same_plant(await db.get(model, record_id), ctx, grouped=grouped, detail=detail)
    return _guard


async def require_technician_in_plant(db, technician_id, plant_id):
    """Relational guard for assignments/scheduling: the technician's USER must
    hold a membership in the record's plant (e.g. a Las Vegas mechanic can never
    be assigned to a Saint-Jérôme work order). Corporate admins pass."""
    tech = await db.get(Technician, technician_id)
    if not tech:
        raise HTTPException(status_code=404, detail="Technician not found")
    user = await db.get(User, tech.user_id)
    if user is not None and user.role == UserRole.admin:
        return tech
    member = (await db.execute(
        select(UserPlant.id).where(
            UserPlant.user_id == tech.user_id, UserPlant.plant_id == plant_id
        )
    )).first()
    if member is None:
        raise HTTPException(status_code=400, detail="errors.technicianNotInPlant")
    return tech
