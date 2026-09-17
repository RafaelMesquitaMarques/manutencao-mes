"""
Replay do turno — reconstrução contra a base real (factory_replay).
===================================================================
Mesmo harness de test_of_watch.py / test_pit_stop.py: um único event loop
partilhado e TODAS as escritas revertidas no fim. Aqui valida-se o que os testes
puros (test_factory_replay.py) não conseguem — o SQL de verdade: o DISTINCT ON
da fila de arrasto, os enums de categoria de parada, os joins ao operador e aos
técnicos, e a tradução de machine_id para equipment_id.

O cenário semeado é um quart de manhã conhecido:

  06:00  OF-1001 entra na serra
  07:00  parada não planeada (lâmina partida) + ticket aberto
  07:30  técnico começa a intervenção; 08:00 entra um segundo técnico
  08:30  intervenção termina (a parada aberta volta a mandar)
  09:00  parada e ticket fecham
  11:00  parada de 20 min SEM categoria (rosa)
  11:00  OF-1002 entra na serra (fica aberta até ao fim do quart)
  12:00  pausa planeada de 30 min
  + uma OF cuja última passagem fechou 10 h ANTES do quart (fila de arrasto)

Correr (dentro do container do backend):
    pytest tests/test_factory_replay_db.py -v
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.core.config import settings                                  # noqa: E402
from app.models.models import (                                       # noqa: E402
    AlertPriority, Equipment, EquipmentStatus, InterventionTechnician, JobOrder,
    JobOrderRun, JobOrderStatus, Machine, MachineIntervention, MachineOperator,
    MachineProductionHourly, MachineStatus, MachineStop, MaintenanceTicket,
    PitStopDirection, PitStopMovement, PitStopSource, Plant, StopCategory,
    StopCategoryType, TicketStatus,
)
from app.services import factory_replay as fr                         # noqa: E402

_LOOP = asyncio.new_event_loop()
_ENGINE = {}

UTC = timezone.utc
# 06:00 → 14:00 hora de Saint-Jérôme (EDT, UTC-4) numa data fixa do passado.
WS = datetime(2026, 6, 16, 10, 0, tzinfo=UTC)
WE = WS + timedelta(hours=8)
H = timedelta(hours=1)
MIN = timedelta(minutes=1)


def _maker():
    if "e" not in _ENGINE:
        _ENGINE["e"] = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    return async_sessionmaker(_ENGINE["e"], expire_on_commit=False)


def with_session(fn):
    """Async body on the shared loop, always rolled back."""
    def wrapper():
        async def runner():
            s = _maker()()
            try:
                await fn(s)
            finally:
                await s.rollback()
                await s.close()
        _LOOP.run_until_complete(runner())
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


async def _seed(s):
    """O quart descrito no cabeçalho. Devolve (plant, saw, conveyor, hvac)."""
    plant = Plant(code=f"T{uuid.uuid4().hex[:6]}", name="Test plant", timezone="America/Toronto")
    s.add(plant)
    await s.flush()

    saw = Equipment(plant_id=plant.id, code=f"SAW-{uuid.uuid4().hex[:6]}", name="Scie",
                    status=EquipmentStatus.running, block_kind="beam_saw", active=True)
    conveyor = Equipment(plant_id=plant.id, code=f"CNV-{uuid.uuid4().hex[:6]}", name="Convoyeur",
                         status=EquipmentStatus.running, block_kind="conveyor", active=True)
    hvac = Equipment(plant_id=plant.id, code=f"HV-{uuid.uuid4().hex[:6]}", name="HVAC",
                     status=EquipmentStatus.running, asset_type="auxiliary", active=True)
    s.add_all([saw, conveyor, hvac])
    await s.flush()
    conveyor.parent_equipment_id = saw.id

    m_saw = Machine(name="Scie", equipment_id=saw.id, plant_id=plant.id, is_active=True,
                    current_status=MachineStatus.running,
                    shifts_config={"morning": {"start": "06:00", "end": "14:00"},
                                   "afternoon": {"start": "14:00", "end": "22:00"}})
    m_conv = Machine(name="Convoyeur", equipment_id=conveyor.id, plant_id=plant.id,
                     is_active=True, current_status=MachineStatus.running)
    s.add_all([m_saw, m_conv])
    await s.flush()

    op = MachineOperator(machine_id=m_saw.id, plant_id=plant.id, name="Opérateur A")
    s.add(op)
    await s.flush()

    unplanned = StopCategory(machine_id=m_saw.id, name="Bris mécanique", type=StopCategoryType.unplanned)
    planned = StopCategory(machine_id=m_saw.id, name="Pause", type=StopCategoryType.planned)
    s.add_all([unplanned, planned])
    await s.flush()

    s.add_all([
        MachineStop(machine_id=m_saw.id, plant_id=plant.id, started_at=WS + 1 * H,
                    ended_at=WS + 3 * H, stop_category_id=unplanned.id,
                    comments="Lame cassée", operator_id=op.id),
        MachineStop(machine_id=m_saw.id, plant_id=plant.id, started_at=WS + 5 * H,
                    ended_at=WS + 5 * H + 20 * MIN),                     # sem categoria → rosa
        MachineStop(machine_id=m_saw.id, plant_id=plant.id, started_at=WS + 6 * H,
                    ended_at=WS + 6 * H + 30 * MIN, stop_category_id=planned.id),
    ])

    ticket = MaintenanceTicket(ticket_number=f"TK-{uuid.uuid4().hex[:8]}", machine_id=m_saw.id,
                               plant_id=plant.id, status=TicketStatus.completed,
                               priority=AlertPriority.high, opened_at=WS + 1 * H,
                               completed_at=WS + 3 * H, description="Bris de lame")
    s.add(ticket)
    await s.flush()

    iv = MachineIntervention(plant_id=plant.id, machine_id=m_saw.id, equipment_id=saw.id,
                             ticket_id=ticket.id, status="completed", called_at=WS + 1 * H,
                             started_at=WS + 1 * H + 30 * MIN, completed_at=WS + 2 * H + 30 * MIN,
                             started_by_name="Tech 1", intervention_type_name="Mécanique")
    s.add(iv)
    await s.flush()
    s.add_all([
        InterventionTechnician(intervention_id=iv.id, name="Tech 1",
                               checked_in_at=WS + 1 * H + 30 * MIN,
                               checked_out_at=WS + 2 * H + 30 * MIN),
        InterventionTechnician(intervention_id=iv.id, name="Tech 2",
                               checked_in_at=WS + 2 * H, checked_out_at=WS + 2 * H + 30 * MIN),
    ])

    def _of(number, product):
        return JobOrder(plant_id=plant.id, job_number=number, product_name=product,
                        status=JobOrderStatus.in_progress, machine_id=m_saw.id)

    tag = uuid.uuid4().hex[:6]
    of_a, of_b, of_old = (_of(f"OF-A-{tag}", "Panneau A"), _of(f"OF-B-{tag}", "Panneau B"),
                          _of(f"OF-OLD-{tag}", "Panneau vieux"))
    s.add_all([of_a, of_b, of_old])
    await s.flush()
    s.add_all([
        JobOrderRun(job_order_id=of_a.id, machine_id=m_saw.id, plant_id=plant.id,
                    started_at=WS, ended_at=WS + 4 * H, pieces=40, operator_id=op.id),
        JobOrderRun(job_order_id=of_b.id, machine_id=m_saw.id, plant_id=plant.id,
                    started_at=WS + 5 * H, ended_at=None, pieces=12),
        JobOrderRun(job_order_id=of_old.id, machine_id=m_saw.id, plant_id=plant.id,
                    started_at=WS - 12 * H, ended_at=WS - 10 * H, pieces=5),
    ])
    s.add(PitStopMovement(plant_id=plant.id, job_order_id=of_a.id, component_code="PAN-1",
                          direction=PitStopDirection("in"), quantity=4,
                          occurred_at=WS + 5 * H, source=PitStopSource.sap))
    s.add_all([
        MachineProductionHourly(machine_id=m_saw.id, hour=WS, count=10, reject_count=1),
        MachineProductionHourly(machine_id=m_saw.id, hour=WS + 1 * H, count=20, reject_count=0),
    ])
    await s.flush()
    return plant, saw, conveyor, hvac, dict(a=of_a, b=of_b, old=of_old)


def _segment_at(track, minutes):
    t = (WS + timedelta(minutes=minutes)).isoformat()
    for seg in track["segments"]:
        if seg["start"] <= t < seg["end"]:
            return seg
    return None


# ── Estados ───────────────────────────────────────────────────────────────────

@with_session
async def test_sequencia_de_estados_do_quart(s):
    """Minuto a minuto: marcha · parada vermelha (o ticket abre, mas uma máquina
    parada continua vermelha, como em live_status.effective_status) · roxo
    enquanto o técnico lá está · vermelho outra vez até a parada fechar · marcha
    · rosa sem categoria · azul na pausa planeada."""
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    got = [(_segment_at(track, m)["status"], _segment_at(track, m)["source"])
           for m in (30, 70, 100, 149, 160, 220, 310, 365, 420)]
    assert got == [
        ("running", "baseline"), ("stopped", "stop"), ("intervention", "intervention"),
        ("intervention", "intervention"), ("stopped", "stop"), ("running", "baseline"),
        ("unjustified", "stop"), ("planned_stop", "stop"), ("running", "baseline"),
    ]


@with_session
async def test_a_parada_carrega_justificacao_e_operador(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    seg = _segment_at(track, 70)
    assert seg["reason"] == "Bris mécanique"
    assert seg["detail"]["comments"] == "Lame cassée"
    assert seg["detail"]["operator"] == "Opérateur A"


@with_session
async def test_o_ticket_fica_registado_a_parte_da_cor(s):
    """A parada vermelha ganha o bloco, mas o badge âmbar tem de continuar exato."""
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    assert _segment_at(track, 70)["status"] == "stopped"
    assert len(track["ticket_spans"]) == 1
    span = track["ticket_spans"][0]
    assert span["start"] == (WS + 1 * H).isoformat()
    assert span["end"] == (WS + 3 * H).isoformat()


@with_session
async def test_tecnicos_com_check_in_e_check_out(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    techs = _segment_at(track, 100)["detail"]["technicians"]
    assert sorted(t["name"] for t in techs) == ["Tech 1", "Tech 2"]
    assert all(t["since"] and t["until"] for t in techs)


@with_session
async def test_ativo_sem_camada_mes_nao_e_pintado_de_verde(s):
    plant, _, _, hvac, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(hvac.id))
    assert track["machine_id"] is None
    assert [seg["status"] for seg in track["segments"]] == ["idle"]
    assert track["segments"][0]["source"] == "no_history"


@with_session
async def test_os_segmentos_cobrem_a_janela_sem_buracos(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    track = next(t for t in tl["tracks"] if t["equipment_id"] == str(saw.id))
    segs = track["segments"]
    assert segs[0]["start"] == WS.isoformat()
    assert segs[-1]["end"] == WE.isoformat()
    assert all(a["end"] == b["start"] for a, b in zip(segs, segs[1:]))


# ── OFs, buffer e produção ────────────────────────────────────────────────────

@with_session
async def test_passagens_da_janela_e_fila_de_arrasto(s):
    """As passagens que tocam a janela, mais a última passagem fechada de cada OF
    nas horas anteriores — é essa que reconstrói o que já estava parqueado à
    saída quando o quart começou (o DISTINCT ON)."""
    plant, saw, _, _, ofs = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    runs = {r["job_number"]: r for r in tl["of_runs"]}
    assert runs[ofs["a"].job_number]["carry_in"] is False
    assert runs[ofs["a"].job_number]["ended_at"] == (WS + 4 * H).isoformat()
    assert runs[ofs["a"].job_number]["operator"] == "Opérateur A"
    assert runs[ofs["b"].job_number]["ended_at"] is None          # ainda aberta no fim do quart
    assert runs[ofs["old"].job_number]["carry_in"] is True
    assert all(r["equipment_id"] == str(saw.id) for r in tl["of_runs"])


@with_session
async def test_ledger_do_buffer_e_producao_horaria(s):
    plant, saw, _, _, ofs = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    assert [p["job_number"] for p in tl["pit_events"]] == [ofs["a"].job_number]
    assert tl["pit_events"][0]["quantity"] == 4
    assert sum(p["count"] for p in tl["production"]) == 30
    assert all(p["equipment_id"] == str(saw.id) for p in tl["production"])


@with_session
async def test_eventos_do_ticket_entram_na_regua(s):
    plant, saw, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    kinds = sorted(e["kind"] for e in tl["events"])
    assert kinds == ["ticket_closed", "ticket_opened"]
    assert all(e["equipment_id"] == str(saw.id) for e in tl["events"])


@with_session
async def test_a_janela_devolvida_e_a_pedida(s):
    plant, _, _, _, _ = await _seed(s)
    tl = await fr.build_timeline(s, plant.id, WS, WE)
    assert tl["start"] == WS.isoformat()
    assert tl["end"] == WE.isoformat()
    assert tl["timezone"] == "America/Toronto"


# ── Janelas de turno ──────────────────────────────────────────────────────────

@with_session
async def test_turnos_do_dia_saem_de_shifts_config(s):
    plant, _, _, _, _ = await _seed(s)
    out = await fr.shift_windows_for_day(s, plant.id, datetime(2026, 6, 16).date())
    assert [w["key"] for w in out["windows"]] == ["morning", "afternoon"]
    assert out["windows"][0]["start"] == WS.isoformat()
    assert out["windows"][0]["end"] == WE.isoformat()
    # Um turno partilhado por N máquinas é UMA opção com a contagem certa.
    assert out["windows"][0]["machine_count"] == 1
    assert out["day"]["start"] < out["day"]["end"]
