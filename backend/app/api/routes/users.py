import secrets
import string
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import List
from uuid import UUID

from app.db.session import get_db
from app.models.models import Plant, User, UserPlant, UserRole, Permission
from app.schemas.user import UserOut, UserAdminUpdate, PermissionOut, PermissionSet, UserCreate, AdminPasswordResetRequest
from app.core.security import hash_password
from app.core.permissions import require_admin

router = APIRouter()


@router.get("/", response_model=List[UserOut])
async def list_users(
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).order_by(User.name))
    return result.scalars().all()


@router.get("/{user_id}", response_model=UserOut)
async def get_user(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.post("/", response_model=UserOut, status_code=201)
async def create_user(
    data: UserCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    existing = await db.execute(select(User).where(User.email == data.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        name=data.name,
        email=data.email,
        password_hash=hash_password(data.password),
        language=data.language,
        role=data.role,
        job_title=data.job_title,
        phone=data.phone,
        must_change_password=data.must_change_password,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=UserOut)
async def update_user(
    user_id: UUID,
    data: UserAdminUpdate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    updates = data.model_dump(exclude_none=True)

    # Email is unique — reject if another user already owns it
    new_email = updates.get("email")
    if new_email and new_email != user.email:
        taken = await db.execute(
            select(User).where(User.email == new_email, User.id != user_id)
        )
        if taken.scalar_one_or_none():
            raise HTTPException(status_code=400, detail="Email already registered to another user")

    for field, value in updates.items():
        setattr(user, field, value)

    await db.commit()
    await db.refresh(user)
    return user


@router.delete("/{user_id}", status_code=204)
async def delete_user(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_admin: User = Depends(require_admin),
):
    if str(user_id) == str(current_admin.id):
        raise HTTPException(status_code=400, detail="Cannot deactivate your own account")

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.active = False
    await db.commit()


@router.delete("/{user_id}/permanent", status_code=204)
async def delete_user_permanently(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_admin: User = Depends(require_admin),
):
    """Hard-delete a user. Blocked when the user has operational history
    (work orders, labor, tickets) — deactivate those instead. Audit-only
    references (who created a PO, who approved a part…) are detached."""
    from sqlalchemy import update as sa_update, func, or_
    from sqlalchemy.exc import IntegrityError
    from app.models.models import (
        Technician, WorkOrder, WorkOrderTechnician, LaborRecord,
        MaintenanceTicket, MaintenanceAlert, EscalationContact,
        MachineOperator, Machine, InterventionPart, MachineIntervention,
        PurchaseOrder, InventoryMovement, WOAction,
    )

    if str(user_id) == str(current_admin.id):
        raise HTTPException(status_code=400, detail="Cannot delete your own account")

    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Never remove the last active admin
    if user.role == UserRole.admin:
        other_admins = (await db.execute(
            select(func.count(User.id)).where(
                User.role == UserRole.admin, User.active == True, User.id != user_id
            )
        )).scalar() or 0
        if other_admins == 0:
            raise HTTPException(status_code=400, detail="Cannot delete the last active admin")

    # ── Operational history blocks deletion ─────────────────────────────────
    blockers: list[str] = []
    wo_count = (await db.execute(
        select(func.count(WorkOrder.id)).where(
            or_(WorkOrder.created_by_id == user_id, WorkOrder.assigned_to_id == user_id)
        )
    )).scalar() or 0
    if wo_count:
        blockers.append(f"{wo_count} work order(s)")

    ticket_count = (await db.execute(
        select(func.count(MaintenanceTicket.id)).where(MaintenanceTicket.assigned_to_id == user_id)
    )).scalar() or 0
    if ticket_count:
        blockers.append(f"{ticket_count} ticket(s)")

    alert_count = (await db.execute(
        select(func.count(MaintenanceAlert.id)).where(MaintenanceAlert.assigned_to_id == user_id)
    )).scalar() or 0
    if alert_count:
        blockers.append(f"{alert_count} alert(s)")

    tech = (await db.execute(
        select(Technician).where(Technician.user_id == user_id)
    )).scalar_one_or_none()
    if tech:
        tech_wos = (await db.execute(
            select(func.count(WorkOrder.id)).where(WorkOrder.executor_id == tech.id)
        )).scalar() or 0
        tech_links = (await db.execute(
            select(func.count(WorkOrderTechnician.work_order_id)).where(
                WorkOrderTechnician.technician_id == tech.id
            )
        )).scalar() or 0
        labor = (await db.execute(
            select(func.count(LaborRecord.id)).where(LaborRecord.technician_id == tech.id)
        )).scalar() or 0
        if tech_wos or tech_links or labor:
            blockers.append(f"technician history ({tech_wos + tech_links} WO link(s), {labor} labor record(s))")

    if blockers:
        raise HTTPException(
            status_code=409,
            detail="User has linked history: " + ", ".join(blockers)
                   + ". Deactivate the user instead to keep records intact.",
        )

    # ── Detach audit-only references, remove config rows, delete ────────────
    try:
        await db.execute(delete(Permission).where(Permission.user_id == user_id))
        await db.execute(delete(UserPlant).where(UserPlant.user_id == user_id))
        await db.execute(delete(EscalationContact).where(EscalationContact.user_id == user_id))
        await db.execute(sa_update(MachineOperator).where(MachineOperator.user_id == user_id).values(user_id=None))
        await db.execute(sa_update(Machine).where(Machine.current_operator_id == user_id).values(current_operator_id=None))
        await db.execute(sa_update(User).where(User.invited_by_id == user_id).values(invited_by_id=None))
        await db.execute(sa_update(InterventionPart).where(InterventionPart.added_by_id == user_id).values(added_by_id=None))
        await db.execute(sa_update(InterventionPart).where(InterventionPart.approved_by_id == user_id).values(approved_by_id=None))
        await db.execute(sa_update(MachineIntervention).where(MachineIntervention.called_by_id == user_id).values(called_by_id=None))
        await db.execute(sa_update(MachineIntervention).where(MachineIntervention.started_by_id == user_id).values(started_by_id=None))
        await db.execute(sa_update(MachineIntervention).where(MachineIntervention.completed_by_id == user_id).values(completed_by_id=None))
        await db.execute(sa_update(PurchaseOrder).where(PurchaseOrder.created_by_id == user_id).values(created_by_id=None))
        await db.execute(sa_update(InventoryMovement).where(InventoryMovement.created_by_id == user_id).values(created_by_id=None))
        await db.execute(sa_update(WOAction).where(WOAction.author_id == user_id).values(author_id=None))
        if tech:
            await db.execute(delete(Technician).where(Technician.id == tech.id))
        await db.delete(user)
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(
            status_code=409,
            detail="User is still referenced by other records. Deactivate the user instead.",
        )


@router.post("/{user_id}/reset-password")
async def admin_reset_password(
    user_id: UUID,
    data: AdminPasswordResetRequest,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if data.mode == "generate":
        alphabet = string.ascii_letters + string.digits
        temp_password = ''.join(secrets.choice(alphabet) for _ in range(8))
        user.password_hash = hash_password(temp_password)
        user.must_change_password = True
        await db.commit()
        return {"success": True, "temp_password": temp_password}
    elif data.mode == "manual":
        if not data.password or len(data.password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters")
        user.password_hash = hash_password(data.password)
        user.must_change_password = True
        await db.commit()
        return {"success": True}
    else:
        raise HTTPException(status_code=400, detail="Invalid mode. Use 'generate' or 'manual'")


@router.get("/{user_id}/permissions", response_model=List[PermissionOut])
async def get_user_permissions(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(
        select(Permission).where(Permission.user_id == user_id)
    )
    return result.scalars().all()


@router.put("/{user_id}/permissions")
async def set_user_permissions(
    user_id: UUID,
    data: PermissionSet,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    await db.execute(delete(Permission).where(Permission.user_id == user_id))
    for perm in data.permissions:
        p = Permission(
            user_id=user_id,
            resource=perm.resource,
            action=perm.action,
            granted=perm.granted,
            plant_id=perm.plant_id,
        )
        db.add(p)
    await db.commit()
    return {"message": "Permissions updated"}


@router.get("/{user_id}/plants")
async def get_user_plants(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    result = await db.execute(
        select(UserPlant, Plant)
        .join(Plant, UserPlant.plant_id == Plant.id)
        .where(UserPlant.user_id == user_id)
        .order_by(UserPlant.is_default.desc(), UserPlant.created_at)
    )
    return [
        {
            "plant_id": str(lnk.plant_id),
            "code": plant.code,
            "name": plant.name,
            "role": lnk.role,
            "is_default": lnk.is_default,
        }
        for lnk, plant in result.all()
    ]


@router.post("/{user_id}/plants/{plant_id}")
async def assign_plant(
    user_id: UUID,
    plant_id: UUID,
    role: UserRole = UserRole.technician,
    is_default: bool = False,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
):
    existing = await db.execute(
        select(UserPlant).where(
            UserPlant.user_id == user_id,
            UserPlant.plant_id == plant_id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="User already assigned to this plant")
    others = (await db.execute(
        select(UserPlant).where(UserPlant.user_id == user_id)
    )).scalars().all()
    # First membership is always the default; an explicit new default demotes the old one.
    if is_default:
        for o in others:
            o.is_default = False
    link = UserPlant(
        user_id=user_id, plant_id=plant_id, role=role,
        is_default=is_default or not others, granted_by_id=admin.id,
    )
    db.add(link)
    await db.commit()
    return {"message": "User assigned to plant successfully"}


@router.delete("/{user_id}/plants/{plant_id}", status_code=204)
async def remove_plant(
    user_id: UUID,
    plant_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    await db.execute(
        delete(UserPlant).where(
            UserPlant.user_id == user_id,
            UserPlant.plant_id == plant_id,
        )
    )
    # Never leave a user with memberships but no default plant.
    remaining = (await db.execute(
        select(UserPlant).where(UserPlant.user_id == user_id)
        .order_by(UserPlant.created_at)
    )).scalars().all()
    if remaining and not any(l.is_default for l in remaining):
        remaining[0].is_default = True
    await db.commit()
