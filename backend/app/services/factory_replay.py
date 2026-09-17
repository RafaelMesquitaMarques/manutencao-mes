"""Replay do turno — reconstrução do passado da fábrica a partir do que JÁ é gravado.

Nenhuma tabela, coluna ou linha nova: tudo aqui é leitura. O estado de uma
máquina no instante T é *derivado* com a MESMA precedência que o modo ao vivo
(`app/services/live_status.py`), e as OFs vêm do ledger de passagens
(`job_order_runs`), que já é o histórico completo de onde cada OF passou.

Precedência de estado (espelha o live):

    1. intervenção ativa (técnico na máquina)            → intervention  (roxo)
    2. parada aberta                                      → maintenance / planned_stop /
                                                            stopped / unjustified
    3. ticket de manutenção aberto                        → maintenance   (âmbar)
    4. nada registrado                                    → running       (verde)

O passo 4 é o mesmo comportamento do live (`machines.current_status` nasce
`running` e volta a `running` quando a parada fecha), por isso é fiel — mas é uma
*inferência por ausência de evento*, e cada segmento carrega `source` para que a
UI possa dizer de onde ele veio.

Limitações conhecidas (documentadas, nunca preenchidas com dados inventados):
  • não existe log de `machines.current_status`; o rosa `unjustified` raramente
    reaparece porque a categoria da parada é gravada na justificativa (muitas
    vezes depois) e o histórico guarda só o valor final;
  • telemetria de cobot (`robot_cell_states`) é só estado atual → no replay os
    filhos seguem integralmente a máquina-mãe (resolvido no frontend, mesma
    regra de parentesco do live);
  • operador ao longo do tempo é parcial (runs/paradas o carregam, o kiosk não
    historiza `current_operator`).
"""
from collections import defaultdict
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional, Sequence
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Equipment, InterventionTechnician, JobOrder, JobOrderRun, Machine,
    MachineIntervention, MachineOperator, MachineProductionHourly, MachineStop,
    MaintenanceAlert, MaintenanceTicket, PitStopMovement, Plant, RejectCategory,
    RejectLog, RejectSubcategory, StopCategory, StopCategoryType,
    StopSubcategory, TicketStatus,
)

# Janela máxima de um replay. Um turno tem 8 h; 24 h cobre "o dia inteiro" e
# mantém o payload numa faixa que o cliente monta de uma vez e navega sem rede.
MAX_WINDOW_HOURS = 24
DEFAULT_TZ = "America/Toronto"

# Intervenções em que o técnico está de facto na máquina (roxo no mapa). Mesmo
# vocabulário de live_status.ACTIVE_INTERVENTION_STATUSES.
_OPEN_TICKET_STATUSES = [
    TicketStatus.open, TicketStatus.in_progress,
    TicketStatus.on_hold_parts, TicketStatus.on_hold_ext,
]

# Prioridade de camada ao resolver o estado num instante (maior ganha).
_P_BASELINE = 0
_P_TICKET = 1
_P_STOP = 2
_P_INTERVENTION = 3

# Tipo da categoria da parada → estado do mapa. Sem categoria = parada sem
# justificativa (rosa), exatamente como `machines.py::open_stop` decide ao vivo.
_STOP_TYPE_STATUS = {
    StopCategoryType.maintenance: "maintenance",
    StopCategoryType.planned: "planned_stop",
    StopCategoryType.unplanned: "stopped",
}


def tz_of(name: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    d = as_utc(dt)
    return d.isoformat() if d else None


# ─── Janelas selecionáveis (turnos do dia) ────────────────────────────────────

def _windows_from_config(cfg: Optional[dict], for_date: date, tz: ZoneInfo) -> list[tuple[str, datetime, datetime]]:
    """(chave, início_utc, fim_utc) por turno configurado, para uma data LOCAL.

    Mesma leitura que `shift_report_service.keyed_shift_windows`: os HH:MM de
    `shifts_config` são hora de parede da planta; um turno que vira a
    meia-noite pertence ao dia em que começa.
    """
    out: list[tuple[str, datetime, datetime]] = []
    for key, c in (cfg or {}).items():
        if not isinstance(c, dict):
            continue
        try:
            sh, sm = [int(x) for x in str(c.get("start", "")).split(":")[:2]]
            eh, em = [int(x) for x in str(c.get("end", "")).split(":")[:2]]
        except (ValueError, TypeError):
            continue
        start_local = datetime.combine(for_date, time(sh, sm), tzinfo=tz)
        end_local = datetime.combine(for_date, time(eh, em), tzinfo=tz)
        if end_local <= start_local:
            end_local += timedelta(days=1)
        out.append((key, start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)))
    return out


async def shift_windows_for_day(db: AsyncSession, plant_id, for_date: date) -> dict:
    """Turnos selecionáveis da planta num dia local + a janela do dia inteiro.

    Agrega os `shifts_config` das máquinas ativas: turnos idênticos (mesma
    chave + mesmo horário) viram UMA opção, com a contagem de máquinas que os
    usam. Plantas sem nenhum `shifts_config` recebem só a opção "dia inteiro" —
    não inventamos turnos padrão.
    """
    plant = await db.get(Plant, plant_id)
    tz = tz_of(plant.timezone if plant else None)

    rows = (await db.execute(
        select(Machine.shifts_config).where(
            Machine.plant_id == plant_id,
            Machine.is_active == True,  # noqa: E712
            Machine.shifts_config.isnot(None),
        )
    )).scalars().all()

    grouped: dict[tuple[str, str, str], int] = defaultdict(int)
    for cfg in rows:
        for key, ws, we in _windows_from_config(cfg, for_date, tz):
            grouped[(key, ws.isoformat(), we.isoformat())] += 1

    windows = [
        {"key": key, "start": ws, "end": we, "machine_count": n}
        for (key, ws, we), n in sorted(grouped.items(), key=lambda kv: kv[0][1])
    ]

    day_start = datetime.combine(for_date, time(0, 0), tzinfo=tz).astimezone(timezone.utc)
    day_end = day_start + timedelta(days=1)
    return {
        "plant_id": str(plant_id),
        "timezone": plant.timezone if plant else DEFAULT_TZ,
        "date": for_date.isoformat(),
        "windows": windows,
        "day": {"start": day_start.isoformat(), "end": day_end.isoformat()},
    }


# ─── Reconstrução de estados ──────────────────────────────────────────────────

class _Layer:
    """Um intervalo candidato a pintar a máquina, com sua prioridade."""
    __slots__ = ("start", "end", "priority", "status", "reason", "source", "ref_id", "detail")

    def __init__(self, start, end, priority, status, reason=None, source=None, ref_id=None, detail=None):
        self.start = start
        self.end = end
        self.priority = priority
        self.status = status
        self.reason = reason
        self.source = source
        self.ref_id = ref_id
        self.detail = detail


def _clip(start: Optional[datetime], end: Optional[datetime],
          w_start: datetime, w_end: datetime) -> Optional[tuple[datetime, datetime]]:
    """Recorta [start, end) na janela. `end` nulo = ainda aberto no fim da janela."""
    s = as_utc(start) or w_start
    e = as_utc(end) or w_end
    s = max(s, w_start)
    e = min(e, w_end)
    return (s, e) if e > s else None


def _resolve_segments(layers: list[_Layer], w_start: datetime, w_end: datetime) -> list[dict]:
    """Varredura por fronteiras: em cada subintervalo vence a camada de maior
    prioridade que o cobre. Segmentos adjacentes iguais são fundidos."""
    bounds = {w_start, w_end}
    for l in layers:
        bounds.add(l.start)
        bounds.add(l.end)
    points = sorted(b for b in bounds if w_start <= b <= w_end)

    out: list[dict] = []
    for i in range(len(points) - 1):
        a, b = points[i], points[i + 1]
        if b <= a:
            continue
        mid = a + (b - a) / 2
        best: Optional[_Layer] = None
        for l in layers:
            if l.start <= mid < l.end and (best is None or l.priority > best.priority):
                best = l
        if best is None:
            continue
        seg = {
            "start": _iso(a), "end": _iso(b),
            "status": best.status, "reason": best.reason,
            "source": best.source, "ref_id": best.ref_id,
            "detail": best.detail,
        }
        prev = out[-1] if out else None
        if (prev and prev["status"] == seg["status"] and prev["reason"] == seg["reason"]
                and prev["source"] == seg["source"] and prev["ref_id"] == seg["ref_id"]
                and prev["end"] == seg["start"]):
            prev["end"] = seg["end"]
        else:
            out.append(seg)
    return out


async def _stop_layers(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> dict[str, list[_Layer]]:
    if not machine_ids:
        return {}
    rows = (await db.execute(
        select(MachineStop, StopCategory.type, StopCategory.name, StopSubcategory.name)
        .outerjoin(StopCategory, StopCategory.id == MachineStop.stop_category_id)
        .outerjoin(StopSubcategory, StopSubcategory.id == MachineStop.stop_subcategory_id)
        .where(
            MachineStop.machine_id.in_(machine_ids),
            MachineStop.started_at < w_end,
            or_(MachineStop.ended_at.is_(None), MachineStop.ended_at > w_start),
        )
    )).all()
    out: dict[str, list[_Layer]] = defaultdict(list)
    for stop, cat_type, cat_name, sub_name in rows:
        span = _clip(stop.started_at, stop.ended_at, w_start, w_end)
        if not span:
            continue
        status = _STOP_TYPE_STATUS.get(cat_type, "unjustified" if cat_type is None else "stopped")
        reason = sub_name or cat_name or (stop.comments or "").strip() or None
        out[str(stop.machine_id)].append(_Layer(
            span[0], span[1], _P_STOP, status,
            reason=(reason[:200] if reason else None), source="stop", ref_id=str(stop.id),
            detail={"comments": (stop.comments or None), "justified_by": stop.justified_by,
                    "job_number": stop.job_number},
        ))
    return out


async def _intervention_layers(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> tuple[dict, dict]:
    """(camadas roxas por máquina, técnicos presentes por intervenção)."""
    if not machine_ids:
        return {}, {}
    rows = (await db.execute(
        select(MachineIntervention).where(
            MachineIntervention.machine_id.in_(machine_ids),
            MachineIntervention.started_at.isnot(None),
            MachineIntervention.started_at < w_end,
            or_(MachineIntervention.completed_at.is_(None),
                MachineIntervention.completed_at > w_start),
        )
    )).scalars().all()

    techs: dict[str, list[dict]] = defaultdict(list)
    if rows:
        for iv_id, name, cin, cout in (await db.execute(
            select(InterventionTechnician.intervention_id, InterventionTechnician.name,
                   InterventionTechnician.checked_in_at, InterventionTechnician.checked_out_at)
            .where(InterventionTechnician.intervention_id.in_([r.id for r in rows]))
            .order_by(InterventionTechnician.checked_in_at.asc())
        )).all():
            techs[str(iv_id)].append({
                "name": name, "since": _iso(cin), "until": _iso(cout),
            })

    layers: dict[str, list[_Layer]] = defaultdict(list)
    for iv in rows:
        span = _clip(iv.started_at, iv.completed_at, w_start, w_end)
        if not span:
            continue
        # Sem check-ins gravados, o nome de quem iniciou é a única fonte —
        # mesma regra de fallback que live_status usa para os pictogramas.
        present = techs.get(str(iv.id)) or (
            [{"name": iv.started_by_name, "since": _iso(iv.started_at), "until": _iso(iv.completed_at)}]
            if iv.started_by_name else []
        )
        layers[str(iv.machine_id)].append(_Layer(
            span[0], span[1], _P_INTERVENTION, "intervention",
            reason=iv.intervention_type_name, source="intervention", ref_id=str(iv.id),
            detail={"technicians": present, "ticket_id": str(iv.ticket_id) if iv.ticket_id else None,
                    "called_at": _iso(iv.called_at), "mechanic_note": iv.mechanic_note},
        ))
    return layers, techs


async def _ticket_layers(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> tuple[dict, dict, list[dict]]:
    """(camadas âmbar por máquina, intervalos de ticket por máquina, eventos da régua)."""
    if not machine_ids:
        return {}, {}, []
    rows = (await db.execute(
        select(MaintenanceTicket).where(
            MaintenanceTicket.machine_id.in_(machine_ids),
            MaintenanceTicket.opened_at < w_end,
            or_(
                MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES),
                MaintenanceTicket.completed_at.is_(None),
                MaintenanceTicket.completed_at > w_start,
            ),
        )
    )).scalars().all()
    layers: dict[str, list[_Layer]] = defaultdict(list)
    spans: dict[str, list[dict]] = defaultdict(list)
    events: list[dict] = []
    for t in rows:
        # Um ticket ainda aberto hoje segue aberto até ao fim da janela; um
        # fechado usa completed_at (ou o fecho pelo técnico, quando existe).
        closed = t.completed_at or t.closed_by_technician_at
        if t.status not in _OPEN_TICKET_STATUSES and closed is None:
            continue
        span = _clip(t.opened_at, None if t.status in _OPEN_TICKET_STATUSES else closed, w_start, w_end)
        if span:
            layers[str(t.machine_id)].append(_Layer(
                span[0], span[1], _P_TICKET, "maintenance",
                reason=t.description[:200] if t.description else None,
                source="ticket", ref_id=str(t.id),
                detail={"ticket_number": t.ticket_number,
                        "priority": t.priority.value if t.priority else None},
            ))
            spans[str(t.machine_id)].append({
                "start": _iso(span[0]), "end": _iso(span[1]),
                "ticket_id": str(t.id), "ticket_number": t.ticket_number,
            })
        opened = as_utc(t.opened_at)
        if opened and w_start <= opened < w_end:
            events.append({"ts": _iso(opened), "kind": "ticket_opened", "machine_id": str(t.machine_id),
                           "label": t.ticket_number, "ref_id": str(t.id)})
        cl = as_utc(closed)
        if cl and w_start <= cl < w_end:
            events.append({"ts": _iso(cl), "kind": "ticket_closed", "machine_id": str(t.machine_id),
                           "label": t.ticket_number, "ref_id": str(t.id)})
    return layers, spans, events


# ─── OFs, produção e eventos ──────────────────────────────────────────────────

# Quanto tempo antes da janela procuramos a ÚLTIMA passagem já fechada de uma OF.
# É o que reconstrói a fila já parqueada na saída das máquinas quando o turno
# começa (as badges +N do mapa); sem isso o replay começaria com filas vazias.
CARRY_IN_HOURS = 72


def _run_row(run, number, product, target, operator, carry_in: bool) -> dict:
    return {
        "id": str(run.id),
        "job_order_id": str(run.job_order_id),
        "job_number": number,
        "product_name": product,
        "target_quantity": target,
        "machine_id": str(run.machine_id),
        "department": run.department,
        "operator": operator,
        "started_at": _iso(run.started_at),
        "ended_at": _iso(run.ended_at),
        "pieces": run.pieces or 0,
        "rejects": run.rejects or 0,
        "last_piece_at": _iso(run.last_piece_at),
        # True = passagem anterior à janela, trazida só para saber o que já estava
        # parqueado no início. Nunca conta como "OF na máquina" durante o replay.
        "carry_in": carry_in,
    }


async def _of_runs(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> list[dict]:
    """Passagens que tocam a janela + a última passagem fechada de cada OF nas
    horas anteriores (fila de arrasto). Uma passagem é a fonte histórica de onde
    a OF estava: `started_at ≤ T < ended_at` = OF na máquina no instante T."""
    if not machine_ids:
        return []
    cols = (JobOrderRun, JobOrder.job_number, JobOrder.product_name,
            JobOrder.target_quantity, MachineOperator.name)
    base = (
        select(*cols)
        .join(JobOrder, JobOrder.id == JobOrderRun.job_order_id)
        .outerjoin(MachineOperator, MachineOperator.id == JobOrderRun.operator_id)
    )
    rows = (await db.execute(
        base.where(
            JobOrderRun.machine_id.in_(machine_ids),
            JobOrderRun.started_at < w_end,
            or_(JobOrderRun.ended_at.is_(None), JobOrderRun.ended_at > w_start),
        ).order_by(JobOrderRun.started_at.asc())
    )).all()
    out = [_run_row(*r, carry_in=False) for r in rows]
    seen_runs = {r["id"] for r in out}

    # Fila de arrasto: por OF, a passagem fechada mais recente antes da janela.
    carry = (await db.execute(
        base.where(
            JobOrderRun.machine_id.in_(machine_ids),
            JobOrderRun.ended_at.isnot(None),
            JobOrderRun.ended_at <= w_start,
            JobOrderRun.ended_at >= w_start - timedelta(hours=CARRY_IN_HOURS),
        )
        .distinct(JobOrderRun.job_order_id)
        .order_by(JobOrderRun.job_order_id, JobOrderRun.ended_at.desc())
    )).all()
    for r in carry:
        row = _run_row(*r, carry_in=True)
        if row["id"] not in seen_runs:
            out.append(row)
    return out


async def _pit_events(db: AsyncSession, plant_id, w_start, w_end) -> list[dict]:
    """Entradas/saídas do buffer Pit Stop na janela — agregadas por OF, direção
    e minuto, para o traço da OF sem despejar o ledger inteiro no cliente."""
    rows = (await db.execute(
        select(PitStopMovement.job_order_id, JobOrder.job_number,
               PitStopMovement.direction, PitStopMovement.component_code,
               PitStopMovement.quantity, PitStopMovement.occurred_at,
               PitStopMovement.destination_machine_id)
        .join(JobOrder, JobOrder.id == PitStopMovement.job_order_id)
        .where(PitStopMovement.plant_id == plant_id,
               PitStopMovement.occurred_at >= w_start,
               PitStopMovement.occurred_at < w_end)
        .order_by(PitStopMovement.occurred_at.asc())
    )).all()
    bucket: dict[tuple, dict] = {}
    for of_id, number, direction, component, qty, at, dest in rows:
        at_utc = as_utc(at)
        minute = at_utc.replace(second=0, microsecond=0)
        key = (str(of_id), direction.value if hasattr(direction, "value") else str(direction), minute)
        entry = bucket.get(key)
        if entry is None:
            entry = bucket[key] = {
                "ts": _iso(minute), "job_order_id": str(of_id), "job_number": number,
                "direction": key[1], "quantity": 0, "components": [],
                "destination_machine_id": str(dest) if dest else None,
            }
        entry["quantity"] += qty or 0
        if component and component not in entry["components"] and len(entry["components"]) < 8:
            entry["components"].append(component)
    return sorted(bucket.values(), key=lambda e: e["ts"])


async def _pit_moved_before(db: AsyncSession, plant_id, w_start) -> list[str]:
    """OFs que já tinham entrado no buffer antes da janela. Uma OF que chegou ao
    Pit Stop deixou de estar parqueada na saída da máquina — sem isto a fila de
    arrasto contaria material que já tinha seguido em frente."""
    rows = (await db.execute(
        select(PitStopMovement.job_order_id)
        .where(PitStopMovement.plant_id == plant_id,
               PitStopMovement.occurred_at < w_start)
        .distinct()
    )).scalars().all()
    return [str(r) for r in rows]


async def _production(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> list[dict]:
    """Contagens reais por hora (feed ADAM). A hora é truncada em UTC, então a
    primeira hora da janela entra mesmo que a janela comece no meio dela."""
    if not machine_ids:
        return []
    first_hour = w_start.replace(minute=0, second=0, microsecond=0)
    rows = (await db.execute(
        select(MachineProductionHourly)
        .where(MachineProductionHourly.machine_id.in_(machine_ids),
               MachineProductionHourly.hour >= first_hour,
               MachineProductionHourly.hour < w_end)
        .order_by(MachineProductionHourly.hour.asc())
    )).scalars().all()
    return [{
        "machine_id": str(r.machine_id), "hour": _iso(r.hour),
        "count": r.count or 0, "reject_count": r.reject_count or 0,
        "job_number": r.job_number,
    } for r in rows]


async def _other_events(db: AsyncSession, machine_ids: Sequence, w_start, w_end) -> list[dict]:
    """Alertas e rejeitos da janela — marcadores da régua que não vêm dos
    segmentos nem dos runs."""
    if not machine_ids:
        return []
    events: list[dict] = []
    for a in (await db.execute(
        select(MaintenanceAlert).where(
            MaintenanceAlert.machine_id.in_(machine_ids),
            MaintenanceAlert.created_at >= w_start,
            MaintenanceAlert.created_at < w_end,
        )
    )).scalars().all():
        events.append({
            "ts": _iso(a.created_at), "kind": "alert", "machine_id": str(a.machine_id),
            "label": a.alert_number, "ref_id": str(a.id),
            "severity": a.priority.value if a.priority else None,
        })
    for log, cat, sub in (await db.execute(
        select(RejectLog, RejectCategory.name, RejectSubcategory.name)
        .outerjoin(RejectCategory, RejectCategory.id == RejectLog.reject_category_id)
        .outerjoin(RejectSubcategory, RejectSubcategory.id == RejectLog.reject_subcategory_id)
        .where(RejectLog.machine_id.in_(machine_ids),
               RejectLog.created_at >= w_start,
               RejectLog.created_at < w_end)
    )).all():
        events.append({
            "ts": _iso(log.created_at), "kind": "reject", "machine_id": str(log.machine_id),
            "label": sub or cat or None, "ref_id": str(log.id),
            "quantity": log.quantity or 0, "job_number": log.job_number,
        })
    return sorted(events, key=lambda e: e["ts"] or "")


# ─── Entrada pública ──────────────────────────────────────────────────────────

async def build_timeline(db: AsyncSession, plant_id, w_start: datetime, w_end: datetime) -> dict:
    """Todo o material do replay para uma janela, chaveado por EQUIPAMENTO — o
    mesmo id que o mapa já usa (`MapMachine.id`), para que o frontend reaproveite
    a geometria, as cores, os filtros e as vistas sem nenhuma tradução."""
    w_start, w_end = as_utc(w_start), as_utc(w_end)
    plant = await db.get(Plant, plant_id)

    equipment = (await db.execute(
        select(Equipment).where(Equipment.plant_id == plant_id, Equipment.active == True)  # noqa: E712
    )).scalars().all()
    # Casamos por EQUIPAMENTO, não por `machines.plant_id`: essa coluna é
    # anulável (backfill) e uma máquina com plant_id nulo mas ligada a um
    # equipamento desta planta perderia todo o histórico. É a mesma regra do
    # modo ao vivo (live_status.live_details_by_equipment).
    machines = (await db.execute(
        select(Machine).where(
            Machine.equipment_id.in_([e.id for e in equipment]),
            Machine.is_active == True,  # noqa: E712
        )
    )).scalars().all() if equipment else []

    machine_by_eq = {str(m.equipment_id): m for m in machines if m.equipment_id}
    eq_by_machine = {str(m.id): str(m.equipment_id) for m in machines if m.equipment_id}
    machine_ids = [m.id for m in machines if m.equipment_id]

    stops = await _stop_layers(db, machine_ids, w_start, w_end)
    interventions, _techs = await _intervention_layers(db, machine_ids, w_start, w_end)
    tickets, ticket_spans, ticket_events = await _ticket_layers(db, machine_ids, w_start, w_end)
    runs = await _of_runs(db, machine_ids, w_start, w_end)
    production = await _production(db, machine_ids, w_start, w_end)
    events = ticket_events + await _other_events(db, machine_ids, w_start, w_end)
    pit = await _pit_events(db, plant_id, w_start, w_end)
    pit_before = await _pit_moved_before(db, plant_id, w_start)

    # Paradas e runs carregam o operador do momento — a única fonte histórica
    # (o kiosk não historiza `machines.current_operator`).
    operators_by_stop: dict[str, str] = {}
    if machine_ids:
        for stop_id, name in (await db.execute(
            select(MachineStop.id, MachineOperator.name)
            .join(MachineOperator, MachineOperator.id == MachineStop.operator_id)
            .where(MachineStop.machine_id.in_(machine_ids),
                   MachineStop.started_at < w_end,
                   or_(MachineStop.ended_at.is_(None), MachineStop.ended_at > w_start))
        )).all():
            operators_by_stop[str(stop_id)] = name

    tracks: list[dict] = []
    for e in equipment:
        m = machine_by_eq.get(str(e.id))
        if m is None:
            # Sem camada MES não há nenhum histórico operacional: cinza honesto
            # ("sem atividade / desconhecido"), nunca um verde inventado.
            tracks.append({
                "equipment_id": str(e.id), "machine_id": None,
                "segments": [{"start": _iso(w_start), "end": _iso(w_end), "status": "idle",
                              "reason": None, "source": "no_history", "ref_id": None, "detail": None}],
                "ticket_spans": [],
            })
            continue
        mid = str(m.id)
        layers: list[_Layer] = [_Layer(w_start, w_end, _P_BASELINE, "running", source="baseline")]
        layers += tickets.get(mid, [])
        for l in stops.get(mid, []):
            if l.ref_id in operators_by_stop:
                l.detail = {**(l.detail or {}), "operator": operators_by_stop[l.ref_id]}
            layers.append(l)
        layers += interventions.get(mid, [])
        tracks.append({
            "equipment_id": str(e.id), "machine_id": mid,
            "segments": _resolve_segments(layers, w_start, w_end),
            "ticket_spans": ticket_spans.get(mid, []),
        })

    for r in runs:
        r["equipment_id"] = eq_by_machine.get(r["machine_id"])
    for p in production:
        p["equipment_id"] = eq_by_machine.get(p["machine_id"])
    for ev in events:
        ev["equipment_id"] = eq_by_machine.get(ev.get("machine_id"))
    for pe in pit:
        if pe.get("destination_machine_id"):
            pe["destination_equipment_id"] = eq_by_machine.get(pe["destination_machine_id"])

    return {
        "plant_id": str(plant_id),
        "timezone": plant.timezone if plant else DEFAULT_TZ,
        "start": _iso(w_start),
        "end": _iso(w_end),
        "generated_at": _iso(datetime.now(timezone.utc)),
        "tracks": tracks,
        "of_runs": runs,
        "pit_events": pit,
        "pit_moved_before": pit_before,
        "production": production,
        "events": sorted(events, key=lambda e: e["ts"] or ""),
    }
