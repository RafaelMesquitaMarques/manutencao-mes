from fastapi import Depends, HTTPException, status, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import User, UserRole, Permission
from app.core.security import get_current_user
from app.db.session import get_db


# ─── Role defaults (mirror of the frontend ROLE_PERMISSIONS in authStore.ts) ────
# Used when a user has NO per-user overrides saved. Admin bypasses everything.
ROLE_PERMISSIONS: dict[str, set[str]] = {
    "operator": {"dashboard:view", "machines:view", "my_work:view"},
    "technician": {
        "dashboard:view", "work_orders:view", "work_orders:update",
        "technicians:view", "equipment:view", "my_work:view",
        "alerts:view", "alerts:create", "tickets:view", "tickets:update",
        "maintenance:view", "machines:view", "schedule:view", "pm_calendar:view",
        "maintenance_plans:view", "inventory:view", "intelligence:view",
    },
    "supervisor": {
        "dashboard:view", "work_orders:view", "work_orders:create", "work_orders:update",
        "technicians:view", "technicians:update", "equipment:view", "my_work:view",
        "alerts:view", "alerts:create", "alerts:update",
        "tickets:view", "tickets:create", "tickets:update",
        "maintenance:view", "supervisor_view:view", "machines:view",
        "schedule:view", "schedule:update", "pm_calendar:view", "kpis:view",
        "maintenance_plans:view", "inventory:view", "intelligence:view",
        "factory_map:view", "dashboards:view", "wo_approval:view",
        "suppliers:view", "purchase_orders:view", "machine_reports:view", "settings_escalation:view",
        "calendar:view",
    },
    "maintenance_director": {
        "dashboard:view",
        "work_orders:view", "work_orders:create", "work_orders:update", "work_orders:delete",
        "technicians:view", "technicians:create", "technicians:update", "technicians:delete",
        "equipment:view", "equipment:create", "equipment:update",
        "my_work:view", "alerts:view", "alerts:create", "alerts:update", "alerts:delete",
        "tickets:view", "tickets:create", "tickets:update", "tickets:delete",
        "maintenance:view", "supervisor_view:view", "machines:view", "machines:update",
        "schedule:view", "schedule:create", "schedule:update", "schedule:delete",
        "pm_calendar:view", "pm_calendar:create", "pm_calendar:update",
        "kpis:view", "settings_machines:view", "settings_machines:update",
        "settings_devices:view", "settings_devices:update",
        "costs:view", "costs:update",
        "maintenance_plans:view", "inventory:view", "intelligence:view",
        "factory_map:view", "dashboards:view", "wo_approval:view",
        "suppliers:view", "purchase_orders:view", "machine_reports:view", "settings_escalation:view",
        "calendar:view", "calendar:update",
    },
    "plant_manager": {
        "dashboard:view",
        "work_orders:view", "work_orders:create", "work_orders:update", "work_orders:delete",
        "technicians:view", "technicians:create", "technicians:update", "technicians:delete",
        "equipment:view", "equipment:create", "equipment:update", "equipment:delete",
        "my_work:view", "alerts:view", "alerts:create", "alerts:update", "alerts:delete",
        "tickets:view", "tickets:create", "tickets:update", "tickets:delete",
        "maintenance:view", "supervisor_view:view", "machines:view", "machines:update",
        "schedule:view", "schedule:create", "schedule:update", "schedule:delete",
        "pm_calendar:view", "pm_calendar:create", "pm_calendar:update", "pm_calendar:delete",
        "kpis:view", "settings_machines:view", "settings_machines:update", "settings_users:view",
        "settings_devices:view", "settings_devices:update",
        "costs:view", "costs:update",
        "maintenance_plans:view", "inventory:view", "intelligence:view",
        "factory_map:view", "dashboards:view", "wo_approval:view",
        "suppliers:view", "purchase_orders:view", "machine_reports:view", "settings_escalation:view",
        "calendar:view", "calendar:update",
    },
    "director": {
        "dashboard:view", "work_orders:view", "technicians:view", "equipment:view",
        "my_work:view", "alerts:view", "tickets:view", "maintenance:view",
        "supervisor_view:view", "machines:view", "schedule:view", "pm_calendar:view",
        "kpis:view", "settings_machines:view", "settings_devices:view", "costs:view",
        "maintenance_plans:view", "inventory:view", "intelligence:view",
        "factory_map:view", "dashboards:view", "wo_approval:view",
        "suppliers:view", "purchase_orders:view", "machine_reports:view", "settings_escalation:view",
        "calendar:view",
    },
}


async def effective_permissions(db: AsyncSession, user: User) -> set[str]:
    """The set of 'resource:action' the user is allowed.
    - admin → {'*'} (everything)
    - has per-user overrides → exactly those granted rows (allow-list)
    - no overrides → the role defaults
    """
    if user.role == UserRole.admin:
        return {"*"}
    rows = (await db.execute(
        select(Permission).where(Permission.user_id == user.id)
    )).scalars().all()
    if rows:
        return {f"{r.resource}:{r.action}" for r in rows if r.granted}
    return set(ROLE_PERMISSIONS.get(user.role.value, set()))


async def user_can(db: AsyncSession, user: User, resource: str, action: str) -> bool:
    perms = await effective_permissions(db, user)
    return "*" in perms or f"{resource}:{action}" in perms


# Map HTTP methods to the permission action. GET/HEAD/OPTIONS are reads (not guarded here).
_WRITE_ACTION = {"PUT": "update", "PATCH": "update", "DELETE": "delete"}


def resource_guard(resource: str):
    """Router-level dependency: enforces create/update/delete permission on writes.
    Reads (GET) pass through with authentication only (view is gated on the frontend
    and would otherwise break shared dropdowns/dashboards)."""
    async def _guard(
        request: Request,
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> None:
        method = request.method
        if method == "POST":
            # POST to the collection root (no path params) creates a new resource;
            # POST to a member route (/{id}/start, /{id}/complete, /{id}/labor, …)
            # acts on an existing resource → that's an update, not a create. Without
            # this distinction a technician (who has update but not create) is wrongly
            # blocked from starting/holding/completing their own work orders.
            action = "update" if request.path_params else "create"
        else:
            action = _WRITE_ACTION.get(method)
        if action is None:
            return
        if not await user_can(db, current_user, resource, action):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You don't have permission to {action} {resource}.",
            )
    return _guard


def role_write_guard(*roles: UserRole):
    """Router-level dependency: reads (GET/HEAD/OPTIONS) pass with auth only; any
    write (POST/PUT/PATCH/DELETE) requires one of `roles` (admin always passes).
    Used where editing is a managerial task but viewing is open — e.g. PM templates:
    technicians may view the standard procedure but only a supervisor+ may change it."""
    allowed = set(roles)

    async def _guard(
        request: Request,
        current_user: User = Depends(get_current_user),
    ) -> None:
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return
        if current_user.role == UserRole.admin or current_user.role in allowed:
            return
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only a supervisor or above can modify this resource.",
        )

    return _guard


def require_permission(resource: str, action: str):
    """Dependency for a single endpoint: enforce one (resource, action). Admin passes."""
    async def _check(
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        if not await user_can(db, current_user, resource, action):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"You don't have permission to {action} {resource}.",
            )
        return current_user
    return _check


# ─── Legacy role-based dependencies (kept; still used by users/auth/escalation) ──

def require_role(*roles: UserRole):
    """Dependency: user must have one of the specified roles (admin always passes)."""
    async def _check(current_user: User = Depends(get_current_user)) -> User:
        if current_user.role == UserRole.admin:
            return current_user
        if current_user.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Insufficient permissions",
            )
        return current_user
    return _check


async def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Dependency: user must be admin."""
    if current_user.role != UserRole.admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )
    return current_user
