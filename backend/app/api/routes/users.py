from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from typing import List
from uuid import UUID

from app.db.session import get_db
from app.models.models import User, UserPlant, UserRole, Permission
from app.schemas.user import UserOut, UserAdminUpdate, PermissionOut, PermissionSet, UserCreate
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
        must_change_password=True,
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

    for field, value in data.model_dump(exclude_none=True).items():
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


@router.post("/{user_id}/plants/{plant_id}")
async def assign_plant(
    user_id: UUID,
    plant_id: UUID,
    role: UserRole = UserRole.technician,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    link = UserPlant(user_id=user_id, plant_id=plant_id, role=role)
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
    await db.commit()
