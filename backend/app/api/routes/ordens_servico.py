from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from typing import Optional
from uuid import UUID
from datetime import datetime, timezone, date as date_type

from app.db.session import get_db
from app.models.models import (
    Usuario, OrdemServico, Equipamento, StatusOS, TipoOS, PrioridadeOS,
    RegistroLabor, WOPart, WOCost, WOAction, Tecnico,
)
from app.schemas.ordem_servico import OSCreate, OSUpdate, OSOut, OSListResponse
from app.schemas.wo_subresources import (
    LaborCreate, LaborOut, LaborListResponse,
    WOPartCreate, WOPartOut, WOPartListResponse,
    WOCostCreate, WOCostOut, WOCostListResponse,
    WOActionCreate, WOActionOut, WOActionListResponse,
    WOCostSummary,
)
from app.core.security import get_current_user

router = APIRouter()


async def _gerar_numero_os(db: AsyncSession) -> str:
    year = datetime.now(timezone.utc).year
    result = await db.execute(
        select(func.count(OrdemServico.id)).where(
            func.extract("year", OrdemServico.data_abertura) == year
        )
    )
    count = result.scalar() + 1
    return f"WO-{year}-{count:05d}"


@router.get("/", response_model=OSListResponse)
async def list_os(
    usina_id: Optional[UUID] = None,
    equipamento_id: Optional[UUID] = None,
    status: Optional[StatusOS] = None,
    tipo: Optional[TipoOS] = None,
    prioridade: Optional[PrioridadeOS] = None,
    executado_por_id: Optional[UUID] = None,
    origem_iot: Optional[bool] = None,
    search: Optional[str] = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    query = select(OrdemServico)

    if equipamento_id:
        query = query.where(OrdemServico.equipamento_id == equipamento_id)
    if status:
        query = query.where(OrdemServico.status == status)
    if tipo:
        query = query.where(OrdemServico.tipo == tipo)
    if prioridade:
        query = query.where(OrdemServico.prioridade == prioridade)
    if executado_por_id:
        query = query.where(OrdemServico.executado_por_id == executado_por_id)
    if origem_iot is not None:
        query = query.where(OrdemServico.origem_iot == origem_iot)
    if search:
        query = query.where(
            OrdemServico.titulo.ilike(f"%{search}%") |
            OrdemServico.numero.ilike(f"%{search}%")
        )
    if usina_id:
        query = query.join(Equipamento).where(Equipamento.usina_id == usina_id)

    total_result = await db.execute(select(func.count()).select_from(query.subquery()))
    total = total_result.scalar()

    query = query.offset(skip).limit(limit).order_by(OrdemServico.data_abertura.desc())
    result = await db.execute(query)
    items = result.scalars().all()

    os_list = []
    for os in items:
        os_data = OSOut.model_validate(os)
        equip = await db.get(Equipamento, os.equipamento_id)
        if equip:
            os_data.equipment_name = equip.nome
            os_data.equipment_location = equip.localizacao
        os_list.append(os_data)

    return OSListResponse(total=total, items=os_list)


@router.get("/dashboard", summary="Counts by status for dashboard")
async def os_dashboard(
    usina_id: Optional[UUID] = None,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    counts: dict = {}
    for st in StatusOS:
        q = select(func.count(OrdemServico.id)).where(OrdemServico.status == st)
        if usina_id:
            q = q.join(Equipamento).where(Equipamento.usina_id == usina_id)
        r = await db.execute(q)
        counts[st.value] = r.scalar()

    # Critical open WOs
    q = select(func.count(OrdemServico.id)).where(
        OrdemServico.prioridade == PrioridadeOS.critical,
        OrdemServico.status.in_([StatusOS.open, StatusOS.in_progress])
    )
    critical_count = (await db.execute(q)).scalar()

    # Completed today
    today = datetime.now(timezone.utc).date()
    q = select(func.count(OrdemServico.id)).where(
        OrdemServico.status == StatusOS.completed,
        func.date(OrdemServico.data_conclusao) == today,
    )
    completed_today = (await db.execute(q)).scalar()

    # By type (only non-zero)
    by_type = []
    for tp in TipoOS:
        q = select(func.count(OrdemServico.id)).where(OrdemServico.tipo == tp)
        cnt = (await db.execute(q)).scalar()
        if cnt:
            by_type.append({"type": tp.value, "count": cnt})

    by_status = [{"status": k, "count": v} for k, v in counts.items() if v]

    return {
        "total_open": counts.get(StatusOS.open.value, 0),
        "in_progress": counts.get(StatusOS.in_progress.value, 0),
        "on_hold": counts.get(StatusOS.on_hold.value, 0),
        "critical": critical_count,
        "completed_today": completed_today,
        "by_type": by_type,
        "by_status": by_status,
    }


@router.get("/{os_id}", response_model=OSOut)
async def get_os(
    os_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(OrdemServico).where(OrdemServico.id == os_id))
    os = result.scalar_one_or_none()
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")
    os_data = OSOut.model_validate(os)
    equip = await db.get(Equipamento, os.equipamento_id)
    if equip:
        os_data.equipment_name = equip.nome
        os_data.equipment_location = equip.localizacao
    return os_data


@router.post("/", response_model=OSOut, status_code=201)
async def create_os(
    data: OSCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    equip = await db.get(Equipamento, data.equipment_id)
    if not equip:
        raise HTTPException(status_code=404, detail="Equipment not found")

    numero = await _gerar_numero_os(db)
    os = OrdemServico(
        numero=numero,
        criado_por_id=current_user.id,
        equipamento_id=data.equipment_id,
        tipo=data.type,
        prioridade=data.priority,
        titulo=data.title,
        short_description=data.short_description,
        descricao=data.description,
        data_prevista=data.due_date,
        executado_por_id=data.assigned_to_id,
        executor_id=data.executor_id,
        execution_mode=data.execution_mode,
        classification=data.classification,
        failure_code=data.failure_code,
        tag=data.tag,
        componente=data.componente,
        project_number=data.project_number,
        cost_center=data.cost_center,
    )
    db.add(os)
    await db.commit()
    await db.refresh(os)

    os_data = OSOut.model_validate(os)
    os_data.equipment_name = equip.nome
    os_data.equipment_location = equip.localizacao
    return os_data


@router.patch("/{os_id}", response_model=OSOut)
async def update_os(
    os_id: UUID,
    data: OSUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(OrdemServico).where(OrdemServico.id == os_id))
    os = result.scalar_one_or_none()
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")

    update_data = data.model_dump(exclude_none=True)

    if "status" in update_data:
        if update_data["status"] == StatusOS.in_progress and not os.data_inicio:
            update_data["data_inicio"] = datetime.now(timezone.utc)
        elif update_data["status"] == StatusOS.completed and not os.data_conclusao:
            update_data["data_conclusao"] = datetime.now(timezone.utc)

    for field, value in update_data.items():
        setattr(os, field, value)

    await db.commit()
    await db.refresh(os)
    return os


@router.post("/{os_id}/iniciar", response_model=OSOut)
async def iniciar_os(
    os_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(OrdemServico).where(OrdemServico.id == os_id))
    os = result.scalar_one_or_none()
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")
    if os.status != StatusOS.open:
        raise HTTPException(status_code=400, detail="Work order is not open")

    os.status = StatusOS.in_progress
    os.data_inicio = datetime.now(timezone.utc)
    os.executado_por_id = current_user.id
    await db.commit()
    await db.refresh(os)
    return os


@router.post("/{os_id}/concluir", response_model=OSOut)
async def concluir_os(
    os_id: UUID,
    causa_raiz: Optional[str] = None,
    solucao_aplicada: Optional[str] = None,
    tempo_reparo_h: Optional[float] = None,
    tempo_parada_h: Optional[float] = None,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(select(OrdemServico).where(OrdemServico.id == os_id))
    os = result.scalar_one_or_none()
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")

    os.status = StatusOS.completed
    os.data_conclusao = datetime.now(timezone.utc)
    if causa_raiz:
        os.causa_raiz = causa_raiz
    if solucao_aplicada:
        os.solucao_aplicada = solucao_aplicada
    if tempo_reparo_h:
        os.tempo_reparo_h = tempo_reparo_h
    if tempo_parada_h:
        os.tempo_parada_h = tempo_parada_h

    await db.commit()
    await db.refresh(os)
    return os


# ─── Labor sub-resource ───────────────────────────────────────────────────────

@router.post("/{os_id}/labor", response_model=LaborOut, status_code=201)
async def add_labor(
    os_id: UUID,
    data: LaborCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    os = await db.get(OrdemServico, os_id)
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")

    tecnico = await db.get(Tecnico, data.tecnico_id)
    rate = data.hourly_rate or (tecnico.hourly_rate if tecnico else None)
    labor_cost = (rate * data.hours_worked) if rate else None

    record = RegistroLabor(
        ordem_id=os_id,
        tecnico_id=data.tecnico_id,
        date=data.date,
        hours_worked=data.hours_worked,
        hourly_rate=rate,
        labor_cost=labor_cost,
        activity=data.activity,
        notes=data.notes,
    )
    db.add(record)
    await db.commit()
    await db.refresh(record)
    return record


@router.get("/{os_id}/labor", response_model=LaborListResponse)
async def list_labor(
    os_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(
        select(RegistroLabor).where(RegistroLabor.ordem_id == os_id)
    )
    items = result.scalars().all()
    return LaborListResponse(total=len(items), items=items)


# ─── Parts sub-resource ───────────────────────────────────────────────────────

@router.post("/{os_id}/parts", response_model=WOPartOut, status_code=201)
async def add_part(
    os_id: UUID,
    data: WOPartCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    os = await db.get(OrdemServico, os_id)
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")

    total_cost = (data.unit_cost * data.quantity) if data.unit_cost else None
    part = WOPart(
        ordem_id=os_id,
        item_estoque_id=data.item_estoque_id,
        part_number=data.part_number,
        description=data.description,
        quantity=data.quantity,
        unit=data.unit,
        unit_cost=data.unit_cost,
        total_cost=total_cost,
        supplier=data.supplier,
        notes=data.notes,
    )
    db.add(part)
    await db.commit()
    await db.refresh(part)
    return part


@router.get("/{os_id}/parts", response_model=WOPartListResponse)
async def list_parts(
    os_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(
        select(WOPart).where(WOPart.ordem_id == os_id)
    )
    items = result.scalars().all()
    return WOPartListResponse(total=len(items), items=items)


# ─── Costs sub-resource ───────────────────────────────────────────────────────

@router.post("/{os_id}/costs", response_model=WOCostOut, status_code=201)
async def add_cost(
    os_id: UUID,
    data: WOCostCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    os = await db.get(OrdemServico, os_id)
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")

    cost = WOCost(
        ordem_id=os_id,
        transaction_type=data.transaction_type,
        description=data.description,
        amount=data.amount,
        currency=data.currency,
        reference=data.reference,
        date=data.date,
        notes=data.notes,
    )
    db.add(cost)
    await db.commit()
    await db.refresh(cost)
    return cost


@router.get("/{os_id}/costs", response_model=WOCostListResponse)
async def list_costs(
    os_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(
        select(WOCost).where(WOCost.ordem_id == os_id)
    )
    items = result.scalars().all()
    return WOCostListResponse(total=len(items), items=items)


@router.get("/{os_id}/costs/summary", response_model=WOCostSummary)
async def cost_summary(
    os_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    costs_result = await db.execute(select(WOCost).where(WOCost.ordem_id == os_id))
    costs = costs_result.scalars().all()

    labor_result = await db.execute(select(RegistroLabor).where(RegistroLabor.ordem_id == os_id))
    labor = labor_result.scalars().all()

    parts_result = await db.execute(select(WOPart).where(WOPart.ordem_id == os_id))
    parts = parts_result.scalars().all()

    labor_total = sum(r.labor_cost or 0 for r in labor)
    parts_total = sum(p.total_cost or 0 for p in parts)
    other_total = sum(c.amount for c in costs)
    return WOCostSummary(
        labor_total=labor_total,
        parts_total=parts_total,
        other_total=other_total,
        grand_total=labor_total + parts_total + other_total,
    )


# ─── Actions sub-resource ─────────────────────────────────────────────────────

@router.post("/{os_id}/actions", response_model=WOActionOut, status_code=201)
async def add_action(
    os_id: UUID,
    data: WOActionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    os = await db.get(OrdemServico, os_id)
    if not os:
        raise HTTPException(status_code=404, detail="Work order not found")

    action = WOAction(
        ordem_id=os_id,
        author_id=current_user.id,
        action_type=data.action_type,
        content=data.content,
        old_value=data.old_value,
        new_value=data.new_value,
    )
    db.add(action)
    await db.commit()
    await db.refresh(action)
    return action


@router.get("/{os_id}/actions", response_model=WOActionListResponse)
async def list_actions(
    os_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Usuario = Depends(get_current_user),
):
    result = await db.execute(
        select(WOAction).where(WOAction.ordem_id == os_id).order_by(WOAction.created_at.asc())
    )
    items = result.scalars().all()
    return WOActionListResponse(total=len(items), items=items)
