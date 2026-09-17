"""
Replay do turno — reconstrução de estados (factory_replay).
===========================================================
Testa a parte que decide o que o mapa mostra em cada instante, SEM base de
dados: a álgebra de intervalos que resolve a precedência (intervenção > parada
> ticket > nada registado), o recorte na janela e as janelas de turno vindas de
`shifts_config` (incluindo o turno que vira a meia-noite).

Estas funções são puras de propósito — é nelas que mora a fidelidade da
reprodução, e o resto do serviço é só leitura da base.

Correr (dentro do container do backend):
    pytest tests/test_factory_replay.py -v
"""
import os
import sys
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.services import factory_replay as fr                     # noqa: E402

UTC = timezone.utc
WS = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
WE = WS + timedelta(hours=8)


def _layer(h_from, h_to, priority, status, **kw):
    return fr._Layer(WS + timedelta(hours=h_from), WS + timedelta(hours=h_to), priority, status, **kw)


def _baseline():
    return fr._Layer(WS, WE, fr._P_BASELINE, "running", source="baseline")


def _at(segments, hours):
    """Estado do segmento que cobre WS+hours."""
    t = WS + timedelta(hours=hours)
    for s in segments:
        if datetime.fromisoformat(s["start"]) <= t < datetime.fromisoformat(s["end"]):
            return s
    return None


class TestPrecedencia:
    def test_sem_eventos_a_maquina_fica_em_marcha(self):
        segs = fr._resolve_segments([_baseline()], WS, WE)
        assert len(segs) == 1
        assert segs[0]["status"] == "running"
        # A origem é explícita: inferido por ausência de evento, não medido.
        assert segs[0]["source"] == "baseline"

    def test_intervencao_ganha_a_parada_que_ganha_o_ticket(self):
        segs = fr._resolve_segments([
            _baseline(),
            _layer(1, 4, fr._P_TICKET, "maintenance", source="ticket", ref_id="T1"),
            _layer(1.5, 3, fr._P_STOP, "stopped", reason="Panne", source="stop", ref_id="S1"),
            _layer(2, 2.75, fr._P_INTERVENTION, "intervention", source="intervention", ref_id="I1"),
        ], WS, WE)
        assert [(_at(segs, h)["status"]) for h in (0.5, 1.2, 1.8, 2.3, 2.9, 3.5, 5)] == [
            "running", "maintenance", "stopped", "intervention", "stopped", "maintenance", "running",
        ]
        # A parada volta a mandar quando a intervenção acaba, e continua a
        # carregar a sua justificação.
        assert _at(segs, 2.9)["reason"] == "Panne"

    def test_segmentos_adjacentes_iguais_sao_fundidos(self):
        segs = fr._resolve_segments([
            _baseline(),
            _layer(2, 4, fr._P_TICKET, "running", source="baseline"),
        ], WS, WE)
        assert len(segs) == 1

    def test_segmentos_cobrem_a_janela_sem_buracos_nem_sobreposicoes(self):
        segs = fr._resolve_segments([
            _baseline(),
            _layer(1, 2, fr._P_STOP, "stopped", source="stop", ref_id="S1"),
            _layer(3, 5, fr._P_STOP, "planned_stop", source="stop", ref_id="S2"),
        ], WS, WE)
        assert datetime.fromisoformat(segs[0]["start"]) == WS
        assert datetime.fromisoformat(segs[-1]["end"]) == WE
        for a, b in zip(segs, segs[1:]):
            assert a["end"] == b["start"]


class TestRecorte:
    def test_intervalo_ainda_aberto_vai_ate_ao_fim_da_janela(self):
        assert fr._clip(WS + timedelta(hours=7), None, WS, WE) == (WS + timedelta(hours=7), WE)

    def test_intervalo_totalmente_fora_e_descartado(self):
        assert fr._clip(WS - timedelta(hours=5), WS - timedelta(hours=1), WS, WE) is None

    def test_intervalo_que_atravessa_a_janela_e_recortado(self):
        assert fr._clip(WS - timedelta(hours=2), WE + timedelta(hours=2), WS, WE) == (WS, WE)

    def test_datas_sem_fuso_sao_lidas_como_utc(self):
        naive = (WS + timedelta(hours=1)).replace(tzinfo=None)
        assert fr._clip(naive, None, WS, WE)[0] == WS + timedelta(hours=1)


class TestParadaParaEstado:
    def test_sem_categoria_a_parada_e_nao_justificada(self):
        from app.models.models import StopCategoryType
        assert fr._STOP_TYPE_STATUS.get(None, "unjustified") == "unjustified"
        assert fr._STOP_TYPE_STATUS[StopCategoryType.planned] == "planned_stop"
        assert fr._STOP_TYPE_STATUS[StopCategoryType.unplanned] == "stopped"
        assert fr._STOP_TYPE_STATUS[StopCategoryType.maintenance] == "maintenance"


class TestJanelasDeTurno:
    TZ = ZoneInfo("America/Toronto")

    def test_turno_normal_em_hora_de_parede_da_planta(self):
        out = fr._windows_from_config(
            {"morning": {"start": "06:00", "end": "14:00"}}, date(2026, 9, 16), self.TZ)
        key, ws, we = out[0]
        assert key == "morning"
        assert ws == datetime(2026, 9, 16, 10, 0, tzinfo=UTC)   # EDT = UTC-4
        assert we - ws == timedelta(hours=8)

    def test_turno_noturno_pertence_ao_dia_em_que_comeca(self):
        out = fr._windows_from_config(
            {"night": {"start": "22:00", "end": "06:00"}}, date(2026, 9, 16), self.TZ)
        _, ws, we = out[0]
        assert ws == datetime(2026, 9, 17, 2, 0, tzinfo=UTC)
        assert we == datetime(2026, 9, 17, 10, 0, tzinfo=UTC)

    def test_configuracao_invalida_e_ignorada_sem_rebentar(self):
        out = fr._windows_from_config(
            {"bad": {"start": "xx", "end": "14:00"}, "none": None,
             "ok": {"start": "08:00", "end": "16:00"}},
            date(2026, 9, 16), self.TZ)
        assert [k for k, _, _ in out] == ["ok"]

    def test_sem_configuracao_nao_inventamos_turnos(self):
        assert fr._windows_from_config(None, date(2026, 9, 16), self.TZ) == []


# ── Montagem da timeline ──────────────────────────────────────────────────────
# `build_timeline` só lê a base; o que interessa testar é a MONTAGEM: cada faixa
# chaveada pelo equipamento (o mesmo id que o mapa usa), ativos sem camada MES a
# saírem cinzentos em vez de verdes inventados, e passagens/eventos traduzidos de
# machine_id para equipment_id. As consultas ficam esvaziadas por stubs.

import asyncio                                                     # noqa: E402
import uuid                                                        # noqa: E402
from types import SimpleNamespace                                  # noqa: E402


class _Result:
    def __init__(self, rows): self._rows = rows
    def all(self): return self._rows
    def scalars(self): return self
    def first(self): return self._rows[0] if self._rows else None
    def scalar_one_or_none(self): return self._rows[0] if self._rows else None


class _ScriptedDB:
    """Devolve resultados por ordem de chamada — a sequência de build_timeline."""
    def __init__(self, plant, results):
        self.plant = plant
        self.results = list(results)
        self.calls = 0

    async def get(self, _model, _pk):
        return self.plant

    async def execute(self, _stmt):
        rows = self.results[self.calls] if self.calls < len(self.results) else []
        self.calls += 1
        return _Result(rows)


def _run(coro):
    return asyncio.get_event_loop_policy().new_event_loop().run_until_complete(coro)


class TestMontagemDaTimeline:
    def _build(self, monkeypatch):
        eq_with = SimpleNamespace(id=uuid.uuid4())
        eq_without = SimpleNamespace(id=uuid.uuid4())
        machine = SimpleNamespace(id=uuid.uuid4(), equipment_id=eq_with.id)
        plant = SimpleNamespace(timezone="America/Toronto")

        stop = fr._Layer(WS, WS + timedelta(hours=1), fr._P_STOP, "stopped",
                         reason="Bris", source="stop", ref_id="stop-1", detail={"comments": "x"})
        monkeypatch.setattr(fr, "_stop_layers", _async({str(machine.id): [stop]}))
        monkeypatch.setattr(fr, "_intervention_layers", _async(({}, {})))
        ticket_layer = fr._Layer(WS, WE, fr._P_TICKET, "maintenance",
                                 source="ticket", ref_id="t1",
                                 detail={"ticket_number": "TK-1"})
        monkeypatch.setattr(fr, "_ticket_layers", _async((
            {str(machine.id): [ticket_layer]},
            {str(machine.id): [{"start": fr._iso(WS), "end": fr._iso(WE),
                                "ticket_id": "t1", "ticket_number": "TK-1"}]},
            [{"ts": fr._iso(WS), "kind": "ticket_opened", "machine_id": str(machine.id),
              "label": "TK-1", "ref_id": "t1"}],
        )))
        monkeypatch.setattr(fr, "_of_runs", _async([{
            "id": "r1", "job_order_id": "of-1", "job_number": "OF-1", "product_name": None,
            "target_quantity": None, "machine_id": str(machine.id), "department": None,
            "operator": None, "started_at": fr._iso(WS), "ended_at": None,
            "pieces": 3, "rejects": 0, "last_piece_at": None, "carry_in": False,
        }]))
        monkeypatch.setattr(fr, "_production", _async([{
            "machine_id": str(machine.id), "hour": fr._iso(WS), "count": 5,
            "reject_count": 0, "job_number": None,
        }]))
        monkeypatch.setattr(fr, "_other_events", _async([]))
        monkeypatch.setattr(fr, "_pit_events", _async([{
            "ts": fr._iso(WS), "job_order_id": "of-1", "job_number": "OF-1",
            "direction": "out", "quantity": 2, "components": [],
            "destination_machine_id": str(machine.id),
        }]))
        monkeypatch.setattr(fr, "_pit_moved_before", _async([]))

        db = _ScriptedDB(plant, [
            [eq_with, eq_without],          # select(Equipment)
            [machine],                      # select(Machine)
            [(uuid.UUID("00000000-0000-0000-0000-000000000001"), "Opérateur A")],  # operador da parada
        ])
        # O id da parada no stub não bate com o da consulta de operadores de
        # propósito: a enriquecimento é best-effort e não pode rebentar.
        out = _run(fr.build_timeline(db, uuid.uuid4(), WS, WE))
        return out, eq_with, eq_without, machine

    def test_cada_equipamento_tem_a_sua_faixa(self, monkeypatch):
        out, eq_with, eq_without, _ = self._build(monkeypatch)
        ids = {t["equipment_id"] for t in out["tracks"]}
        assert ids == {str(eq_with.id), str(eq_without.id)}

    def test_ativo_sem_camada_mes_fica_cinzento_e_declarado(self, monkeypatch):
        out, _, eq_without, _ = self._build(monkeypatch)
        bare = next(t for t in out["tracks"] if t["equipment_id"] == str(eq_without.id))
        assert bare["machine_id"] is None
        assert [s["status"] for s in bare["segments"]] == ["idle"]
        assert bare["segments"][0]["source"] == "no_history"

    def test_a_maquina_alterna_parada_e_marcha(self, monkeypatch):
        out, eq_with, _, _ = self._build(monkeypatch)
        tr = next(t for t in out["tracks"] if t["equipment_id"] == str(eq_with.id))
        assert [s["status"] for s in tr["segments"]] == ["stopped", "maintenance"]
        # O ticket continua aberto toda a janela, à parte da cor que ganha.
        assert tr["ticket_spans"][0]["ticket_number"] == "TK-1"

    def test_passagens_eventos_e_buffer_ganham_o_id_do_equipamento(self, monkeypatch):
        out, eq_with, _, _ = self._build(monkeypatch)
        assert out["of_runs"][0]["equipment_id"] == str(eq_with.id)
        assert out["production"][0]["equipment_id"] == str(eq_with.id)
        assert out["events"][0]["equipment_id"] == str(eq_with.id)
        assert out["pit_events"][0]["destination_equipment_id"] == str(eq_with.id)

    def test_a_janela_e_devolvida_tal_como_pedida(self, monkeypatch):
        out, _, _, _ = self._build(monkeypatch)
        assert datetime.fromisoformat(out["start"]) == WS
        assert datetime.fromisoformat(out["end"]) == WE
        assert out["timezone"] == "America/Toronto"


def _async(value):
    async def _f(*_a, **_k):
        return value
    return _f
