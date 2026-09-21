"""
Shift replay — state reconstruction (factory_replay).
=====================================================
Tests the part that decides what the map shows at each instant, WITHOUT a
database: the interval algebra that resolves precedence (intervention > stop
> ticket > nothing recorded), clipping to the window and the shift windows
coming from `shifts_config` (including the shift that crosses midnight).

These functions are pure on purpose — that is where the fidelity of the
playback lives, and the rest of the service is just reading the database.

Run (inside the backend container):
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
    """State of the segment that covers WS+hours."""
    t = WS + timedelta(hours=hours)
    for s in segments:
        if datetime.fromisoformat(s["start"]) <= t < datetime.fromisoformat(s["end"]):
            return s
    return None


class TestPrecedence:
    def test_without_events_the_machine_stays_running(self):
        segs = fr._resolve_segments([_baseline()], WS, WE)
        assert len(segs) == 1
        assert segs[0]["status"] == "running"
        # The origin is explicit: inferred from the absence of events, not measured.
        assert segs[0]["source"] == "baseline"

    def test_intervention_beats_stop_which_beats_ticket(self):
        segs = fr._resolve_segments([
            _baseline(),
            _layer(1, 4, fr._P_TICKET, "maintenance", source="ticket", ref_id="T1"),
            _layer(1.5, 3, fr._P_STOP, "stopped", reason="Panne", source="stop", ref_id="S1"),
            _layer(2, 2.75, fr._P_INTERVENTION, "intervention", source="intervention", ref_id="I1"),
        ], WS, WE)
        assert [(_at(segs, h)["status"]) for h in (0.5, 1.2, 1.8, 2.3, 2.9, 3.5, 5)] == [
            "running", "maintenance", "stopped", "intervention", "stopped", "maintenance", "running",
        ]
        # The stop takes over again when the intervention ends, and still
        # carries its justification.
        assert _at(segs, 2.9)["reason"] == "Panne"

    def test_identical_adjacent_segments_are_merged(self):
        segs = fr._resolve_segments([
            _baseline(),
            _layer(2, 4, fr._P_TICKET, "running", source="baseline"),
        ], WS, WE)
        assert len(segs) == 1

    def test_segments_cover_the_window_without_gaps_or_overlaps(self):
        segs = fr._resolve_segments([
            _baseline(),
            _layer(1, 2, fr._P_STOP, "stopped", source="stop", ref_id="S1"),
            _layer(3, 5, fr._P_STOP, "planned_stop", source="stop", ref_id="S2"),
        ], WS, WE)
        assert datetime.fromisoformat(segs[0]["start"]) == WS
        assert datetime.fromisoformat(segs[-1]["end"]) == WE
        for a, b in zip(segs, segs[1:]):
            assert a["end"] == b["start"]


class TestClipping:
    def test_still_open_interval_extends_to_the_end_of_the_window(self):
        assert fr._clip(WS + timedelta(hours=7), None, WS, WE) == (WS + timedelta(hours=7), WE)

    def test_interval_entirely_outside_is_discarded(self):
        assert fr._clip(WS - timedelta(hours=5), WS - timedelta(hours=1), WS, WE) is None

    def test_interval_spanning_the_window_is_clipped(self):
        assert fr._clip(WS - timedelta(hours=2), WE + timedelta(hours=2), WS, WE) == (WS, WE)

    def test_naive_datetimes_are_read_as_utc(self):
        naive = (WS + timedelta(hours=1)).replace(tzinfo=None)
        assert fr._clip(naive, None, WS, WE)[0] == WS + timedelta(hours=1)


class TestStopToState:
    def test_without_category_the_stop_is_unjustified(self):
        from app.models.models import StopCategoryType
        assert fr._STOP_TYPE_STATUS.get(None, "unjustified") == "unjustified"
        assert fr._STOP_TYPE_STATUS[StopCategoryType.planned] == "planned_stop"
        assert fr._STOP_TYPE_STATUS[StopCategoryType.unplanned] == "stopped"
        assert fr._STOP_TYPE_STATUS[StopCategoryType.maintenance] == "maintenance"


class TestShiftWindows:
    TZ = ZoneInfo("America/Toronto")

    def test_regular_shift_in_plant_wall_clock_time(self):
        out = fr._windows_from_config(
            {"morning": {"start": "06:00", "end": "14:00"}}, date(2026, 9, 16), self.TZ)
        key, ws, we = out[0]
        assert key == "morning"
        assert ws == datetime(2026, 9, 16, 10, 0, tzinfo=UTC)   # EDT = UTC-4
        assert we - ws == timedelta(hours=8)

    def test_night_shift_belongs_to_the_day_it_starts(self):
        out = fr._windows_from_config(
            {"night": {"start": "22:00", "end": "06:00"}}, date(2026, 9, 16), self.TZ)
        _, ws, we = out[0]
        assert ws == datetime(2026, 9, 17, 2, 0, tzinfo=UTC)
        assert we == datetime(2026, 9, 17, 10, 0, tzinfo=UTC)

    def test_invalid_config_is_ignored_without_crashing(self):
        out = fr._windows_from_config(
            {"bad": {"start": "xx", "end": "14:00"}, "none": None,
             "ok": {"start": "08:00", "end": "16:00"}},
            date(2026, 9, 16), self.TZ)
        assert [k for k, _, _ in out] == ["ok"]

    def test_without_config_we_do_not_invent_shifts(self):
        assert fr._windows_from_config(None, date(2026, 9, 16), self.TZ) == []


# ── Timeline assembly ─────────────────────────────────────────────────────────
# `build_timeline` only reads the database; what matters to test is the ASSEMBLY:
# each track keyed by equipment (the same id the map uses), assets without a MES
# layer coming out grey instead of made-up green, and runs/events translated from
# machine_id to equipment_id. The queries are emptied out by stubs.

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
    """Returns results in call order — the sequence of build_timeline."""
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
    return asyncio.run(coro)   # own loop, closed on exit — nothing here touches the DB


class TestTimelineAssembly:
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
            [(uuid.UUID("00000000-0000-0000-0000-000000000001"), "Opérateur A")],  # the stop's operator
        ])
        # The stop id in the stub does not match the one in the operators query on
        # purpose: the enrichment is best-effort and must not blow up.
        out = _run(fr.build_timeline(db, uuid.uuid4(), WS, WE))
        return out, eq_with, eq_without, machine

    def test_each_equipment_has_its_own_track(self, monkeypatch):
        out, eq_with, eq_without, _ = self._build(monkeypatch)
        ids = {t["equipment_id"] for t in out["tracks"]}
        assert ids == {str(eq_with.id), str(eq_without.id)}

    def test_asset_without_mes_layer_is_grey_and_declared(self, monkeypatch):
        out, _, eq_without, _ = self._build(monkeypatch)
        bare = next(t for t in out["tracks"] if t["equipment_id"] == str(eq_without.id))
        assert bare["machine_id"] is None
        assert [s["status"] for s in bare["segments"]] == ["idle"]
        assert bare["segments"][0]["source"] == "no_history"

    def test_the_machine_goes_from_stop_to_open_ticket(self, monkeypatch):
        out, eq_with, _, _ = self._build(monkeypatch)
        tr = next(t for t in out["tracks"] if t["equipment_id"] == str(eq_with.id))
        assert [s["status"] for s in tr["segments"]] == ["stopped", "maintenance"]
        # The ticket stays open the whole window, separately from the color that wins.
        assert tr["ticket_spans"][0]["ticket_number"] == "TK-1"

    def test_runs_events_and_buffer_get_the_equipment_id(self, monkeypatch):
        out, eq_with, _, _ = self._build(monkeypatch)
        assert out["of_runs"][0]["equipment_id"] == str(eq_with.id)
        assert out["production"][0]["equipment_id"] == str(eq_with.id)
        assert out["events"][0]["equipment_id"] == str(eq_with.id)
        assert out["pit_events"][0]["destination_equipment_id"] == str(eq_with.id)

    def test_the_window_is_returned_as_requested(self, monkeypatch):
        out, _, _, _ = self._build(monkeypatch)
        assert datetime.fromisoformat(out["start"]) == WS
        assert datetime.fromisoformat(out["end"]) == WE
        assert out["timezone"] == "America/Toronto"


def _async(value):
    async def _f(*_a, **_k):
        return value
    return _f
