from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional
from uuid import UUID, uuid4
import qrcode
import io, base64

from app.db.session import get_db
from app.models.models import Usuario, Equipamento, StatusEquipamento
from app.schemas.equipamento import (
    EquipamentoCreate, EquipamentoUpdate, EquipamentoOut, EquipamentoListResponse
)
from app.core.security import get_current_user

router = APIRouter()


@router.get("/", response_model=EquipamentoListResponse)
async def list_equipamentos(
    usina_id: Optional[UUID] = None,
    status: Optional[StatusEquipamento] = None,
    criticidade: Optional[str] = None,
    search: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    query = select(Equipamento).where(Equipamento.ativo == True)

    if usina_id:
        query = query.where(Equipamento.usina_id == usina_id)
    if status:
        query = query.where(Equipamento.status == status)
    if criticidade:
        query = query.where(Equipamento.criticidade == criticidade)
    if search:
        query = query.where(
            Equipamento.nome.ilike(f"%{search}%") |
            Equipamento.codigo.ilike(f"%{search}%") |
            Equipamento.localizacao.ilike(f"%{search}%")
        )

    total_result = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_result.scalar()

    query = query.offset(skip).limit(limit).order_by(Equipamento.nome)
    result = await db.execute(query)
    items = result.scalars().all()

    return EquipamentoListResponse(total=total, items=items)


@router.get("/{equipamento_id}", response_model=EquipamentoOut)
async def get_equipamento(
    equipamento_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(Equipamento).where(Equipamento.id == equipamento_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")
    return equip


@router.post("/", response_model=EquipamentoOut, status_code=201)
async def create_equipamento(
    data: EquipamentoCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    equip = Equipamento(**data.model_dump())

    # Gera QR Code automático
    qr_data = f"equip:{equip.id}"
    qr = qrcode.make(qr_data)
    buf = io.BytesIO()
    qr.save(buf, format="PNG")
    equip.qr_code = base64.b64encode(buf.getvalue()).decode()

    db.add(equip)
    await db.commit()
    await db.refresh(equip)
    return equip


@router.patch("/{equipamento_id}", response_model=EquipamentoOut)
async def update_equipamento(
    equipamento_id: UUID,
    data: EquipamentoUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(Equipamento).where(Equipamento.id == equipamento_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")

    for field, value in data.model_dump(exclude_none=True).items():
        setattr(equip, field, value)

    await db.commit()
    await db.refresh(equip)
    return equip


@router.delete("/{equipamento_id}", status_code=204)
async def delete_equipamento(
    equipamento_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(Equipamento).where(Equipamento.id == equipamento_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")
    equip.ativo = False  # soft delete
    await db.commit()


@router.patch("/{equipamento_id}/horametro")
async def update_horametro(
    equipamento_id: UUID,
    horas: float,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    """Atualiza o horímetro do equipamento (acumulado)."""
    result = await db.execute(select(Equipamento).where(Equipamento.id == equipamento_id))
    equip = result.scalar_one_or_none()
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")
    equip.hora_metro = horas
    await db.commit()
    return {"hora_metro": equip.hora_metro}
