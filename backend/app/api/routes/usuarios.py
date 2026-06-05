from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List
from uuid import UUID

from app.db.session import get_db
from app.models.models import Usuario, UsuarioUsina, RolUsuario
from app.schemas.usuario import UsuarioOut, UsuarioUpdate
from app.core.security import get_current_user

router = APIRouter()


@router.get("/", response_model=List[UsuarioOut])
async def list_usuarios(
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(Usuario).where(Usuario.ativo == True))
    return result.scalars().all()


@router.get("/{usuario_id}", response_model=UsuarioOut)
async def get_usuario(
    usuario_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(Usuario).where(Usuario.id == usuario_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.patch("/{usuario_id}", response_model=UsuarioOut)
async def update_usuario(
    usuario_id: UUID,
    data: UsuarioUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(Usuario).where(Usuario.id == usuario_id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    for field, value in data.model_dump(exclude_none=True).items():
        setattr(user, field, value)

    await db.commit()
    await db.refresh(user)
    return user


@router.post("/{usuario_id}/usinas/{usina_id}")
async def assign_usina(
    usuario_id: UUID,
    usina_id: UUID,
    papel: RolUsuario = RolUsuario.tecnico,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    """Atribui um usuário a uma usina com um papel específico."""
    link = UsuarioUsina(usuario_id=usuario_id, usina_id=usina_id, papel=papel)
    db.add(link)
    await db.commit()
    return {"message": "User assigned to plant successfully"}
