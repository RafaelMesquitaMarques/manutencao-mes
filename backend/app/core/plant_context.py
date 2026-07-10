"""Plant context — the single enforcement point for multi-plant access.

Resolves which plant a request operates on and whether the authenticated user
may access it. Membership (and the role held at each plant) lives in
`user_plants`; `User.role` stays as the global role, where `admin` means
corporate — access to every active plant.

Protocol: the frontend sends the active plant in the `X-Plant-Id` header. A
missing header falls back to the user's default plant, so pre-existing clients
keep working during the phased rollout. An explicit plant the user is not a
member of → 403 with a stable error code (frontend maps codes to t(...)).

Wrong-plant *records* (detail routes) must return 404, not 403 — never confirm
that data exists in a plant the caller cannot see. Use `PlantContext.can_access`
for that check.
"""
import uuid
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import Plant, User, UserPlant, UserRole

PLANT_HEADER = "x-plant-id"

# Stable error codes (mapped to t(...) on the frontend, per backend i18n rule).
ERR_NO_PLANT_ACCESS = "errors.noPlantAccess"
ERR_PLANT_NOT_AUTHORIZED = "errors.plantNotAuthorized"


@dataclass(frozen=True)
class PlantContext:
    user: User
    plant_id: uuid.UUID
    role: UserRole                          # role held at the active plant
    allowed_plant_ids: frozenset            # every plant the user may switch to
    is_corporate: bool                      # global admin: all active plants
    # Plants sharing the ACTIVE plant's group_code (always includes plant_id).
    # Group-scoped resources (inventory, suppliers) are visible across it:
    # SJ+Mirabel pool as 'QC'; an ungrouped plant (Las Vegas) sees only itself.
    group_plant_ids: frozenset = frozenset()
    # Union of the groups of EVERY allowed plant — the widest set of plants
    # whose GROUP-scoped rows this user may see (used by the Ask Ninja RLS GUC).
    allowed_group_plant_ids: frozenset = frozenset()

    def can_access(self, plant_id) -> bool:
        """Whether a record owned by `plant_id` is visible to this user at all
        (any of their plants — for detail routes, where the active plant is the
        UI context but ownership by any authorized plant is what matters)."""
        return plant_id is not None and plant_id in self.allowed_plant_ids

    def can_access_grouped(self, plant_id) -> bool:
        """Detail-route check for GROUP-scoped records (stock items, suppliers):
        visible when owned by any plant in the active plant's group."""
        return plant_id is not None and plant_id in self.group_plant_ids


async def resolve_plant_context(
    db: AsyncSession,
    current_user: User,
    requested_raw: str | None,
) -> PlantContext:
    """Pure resolution logic (dependency-free, so tests can drive it directly)."""
    is_corporate = current_user.role == UserRole.admin

    links = (await db.execute(
        select(UserPlant)
        .join(Plant, UserPlant.plant_id == Plant.id)
        .where(UserPlant.user_id == current_user.id, Plant.active == True)  # noqa: E712
        .order_by(UserPlant.is_default.desc(), UserPlant.created_at)
    )).scalars().all()

    if is_corporate:
        plant_ids = (await db.execute(
            select(Plant.id).where(Plant.active == True)  # noqa: E712
            .order_by(Plant.created_at, Plant.code)
        )).scalars().all()
        allowed = frozenset(plant_ids)
    else:
        allowed = frozenset(l.plant_id for l in links)

    if not allowed:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail=ERR_NO_PLANT_ACCESS)

    if requested_raw:
        try:
            requested = uuid.UUID(requested_raw)
        except ValueError:
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail=ERR_PLANT_NOT_AUTHORIZED)
        if requested not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, detail=ERR_PLANT_NOT_AUTHORIZED)
        plant_id = requested
    elif links:
        plant_id = links[0].plant_id        # is_default first, then oldest membership
    else:
        plant_id = plant_ids[0]             # corporate admin with no membership rows

    role_by_plant = {l.plant_id: l.role for l in links}
    role = UserRole.admin if is_corporate else role_by_plant.get(plant_id, current_user.role)

    active_group = (await db.execute(
        select(Plant.group_code).where(Plant.id == plant_id)
    )).scalar_one_or_none()
    if active_group:
        group_ids = (await db.execute(
            select(Plant.id).where(Plant.group_code == active_group, Plant.active == True)  # noqa: E712
        )).scalars().all()
        group = frozenset(group_ids)
    else:
        group = frozenset({plant_id})

    # Widest group visibility: every plant sharing a group with ANY allowed plant.
    allowed_groups = set((await db.execute(
        select(Plant.group_code).where(Plant.id.in_(list(allowed)), Plant.group_code.isnot(None))
    )).scalars().all())
    if allowed_groups:
        grouped_ids = (await db.execute(
            select(Plant.id).where(Plant.group_code.in_(list(allowed_groups)), Plant.active == True)  # noqa: E712
        )).scalars().all()
        allowed_grouped = frozenset(grouped_ids) | allowed
    else:
        allowed_grouped = allowed

    return PlantContext(
        user=current_user,
        plant_id=plant_id,
        role=role,
        allowed_plant_ids=allowed,
        is_corporate=is_corporate,
        group_plant_ids=group,
        allowed_group_plant_ids=allowed_grouped,
    )


async def get_plant_context(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PlantContext:
    return await resolve_plant_context(db, current_user, request.headers.get(PLANT_HEADER))
