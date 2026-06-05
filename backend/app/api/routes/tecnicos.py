from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID

from app.db.session import get_db
from app.models.models import Tecnico, Usuario
from app.schemas.tecnico import TecnicoCreate, TecnicoOut, TecnicoListResponse
from app.core.security import get_current_user

router = APIRouter()


@router.get("/", response_model=TecnicoListResponse)
async def list_technicians(
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(Tecnico).where(Tecnico.active == True))
    tecnicos = result.scalars().all()

    items = []
    for t in tecnicos:
        out = TecnicoOut.model_validate(t)
        user = await db.get(Usuario, t.user_id)
        if user:
            out.full_name = user.nome
            out.email = user.email
        items.append(out)

    return TecnicoListResponse(total=len(items), items=items)


@router.get("/{tecnico_id}", response_model=TecnicoOut)
async def get_technician(
    tecnico_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    t = await db.get(Tecnico, tecnico_id)
    if not t:
        raise HTTPException(status_code=404, detail="Technician not found")
    out = TecnicoOut.model_validate(t)
    user = await db.get(Usuario, t.user_id)
    if user:
        out.full_name = user.nome
        out.email = user.email
    return out


@router.post("/", response_model=TecnicoOut, status_code=201)
async def create_technician(
    data: TecnicoCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    user = await db.get(Usuario, data.user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    existing = await db.execute(select(Tecnico).where(Tecnico.user_id == data.user_id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Technician profile already exists for this user")

    t = Tecnico(
        user_id=data.user_id,
        employee_number=data.employee_number,
        specialty=data.specialty,
        shift=data.shift,
        hourly_rate=data.hourly_rate,
        certifications=data.certifications or [],
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)

    out = TecnicoOut.model_validate(t)
    out.full_name = user.nome
    out.email = user.email
    return out
