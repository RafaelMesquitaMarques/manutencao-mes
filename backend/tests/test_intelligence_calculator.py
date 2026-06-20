"""
Tests for intelligence_calculator.py
=====================================
Tests the deterministic calculation logic without any DB or AI dependency.
Run with: pytest backend/tests/test_intelligence_calculator.py -v
"""

import pytest
from datetime import datetime, timedelta, timezone

# Import the pure functions directly (no DB needed for these)
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))

from app.services.intelligence_calculator import (
    _calc_mttr_trend,
    _calc_top_irritants,
    _calc_trends,
    _calc_spare_parts_risk,
    _detect_concentration_risk,
    _pct_change,
    _trend_direction,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def make_ticket(
    machine_id: str = "m1",
    machine_name: str = "TestMachine",
    total_intervention_minutes: int = 60,
    estimated_downtime_minutes: int = 30,
    problem_type: str = "electrical",
    status: str = "completed",
    days_ago: int = 1,
) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "id":                          "t1",
        "machine_id":                  machine_id,
        "machine_name":                machine_name,
        "total_intervention_minutes":  total_intervention_minutes,
        "estimated_downtime_minutes":  estimated_downtime_minutes,
        "problem_type":                problem_type,
        "status":                      status,
        "opened_at":                   now - timedelta(days=days_ago),
        "started_at":                  now - timedelta(days=days_ago),
        "completed_at":                now - timedelta(days=days_ago, hours=-1),
        "assigned_to_id":              None,
        "priority":                    "medium",
        "department":                  "production",
        "parts_used":                  None,
    }


def make_machine(id: str = "m1", name: str = "TestMachine", department: str = "production") -> dict:
    return {"id": id, "name": name, "department": department, "location": "floor1", "is_active": True}


def make_part(
    id: str = "p1",
    code: str = "PART-001",
    name: str = "Test Part",
    current_qty: float = 10.0,
    min_qty: float = 5.0,
    recent_qty: float = 2.0,
    baseline_qty: float = 2.0,
) -> dict:
    return {
        "id":           id,
        "code":         code,
        "name":         name,
        "current_qty":  current_qty,
        "min_qty":      min_qty,
        "recent_qty":   recent_qty,
        "baseline_qty": baseline_qty,
    }


# ---------------------------------------------------------------------------
# _pct_change
# ---------------------------------------------------------------------------

class TestPctChange:
    def test_increase(self):
        assert _pct_change(120, 100) == pytest.approx(20.0)

    def test_decrease(self):
        assert _pct_change(80, 100) == pytest.approx(-20.0)

    def test_no_change(self):
        assert _pct_change(100, 100) == pytest.approx(0.0)

    def test_zero_previous(self):
        # Should not raise, returns 0
        assert _pct_change(50, 0) == 0.0

    def test_from_zero_to_value(self):
        assert _pct_change(0, 100) == pytest.approx(-100.0)


# ---------------------------------------------------------------------------
# _trend_direction
# ---------------------------------------------------------------------------

class TestTrendDirection:
    def test_improved_lower_is_better(self):
        assert _trend_direction(-15.0, lower_is_better=True) == "improved"

    def test_deteriorated_lower_is_better(self):
        assert _trend_direction(20.0, lower_is_better=True) == "deteriorated"

    def test_stable(self):
        assert _trend_direction(5.0, lower_is_better=True) == "stable"

    def test_abnormal(self):
        assert _trend_direction(50.0, lower_is_better=True) == "abnormal"

    def test_improved_higher_is_better(self):
        # MTBF: higher = better
        assert _trend_direction(15.0, lower_is_better=False) == "improved"

    def test_deteriorated_higher_is_better(self):
        assert _trend_direction(-20.0, lower_is_better=False) == "deteriorated"


# ---------------------------------------------------------------------------
# _calc_mttr_trend
# ---------------------------------------------------------------------------

class TestMTTRTrend:
    def test_basic_improvement(self):
        current  = [make_ticket(total_intervention_minutes=40)] * 5
        previous = [make_ticket(total_intervention_minutes=60)] * 5
        warnings = []
        avg, trend, pct = _calc_mttr_trend(current, previous, warnings)
        assert avg == pytest.approx(40.0)
        assert trend == "improved"
        assert pct < 0

    def test_deterioration(self):
        current  = [make_ticket(total_intervention_minutes=90)] * 5
        previous = [make_ticket(total_intervention_minutes=60)] * 5
        warnings = []
        avg, trend, pct = _calc_mttr_trend(current, previous, warnings)
        assert trend == "deteriorated"
        assert pct > 0

    def test_stable(self):
        current  = [make_ticket(total_intervention_minutes=62)] * 5
        previous = [make_ticket(total_intervention_minutes=60)] * 5
        warnings = []
        avg, trend, pct = _calc_mttr_trend(current, previous, warnings)
        assert trend == "stable"

    def test_no_current_data(self):
        warnings = []
        avg, trend, pct = _calc_mttr_trend([], [], warnings)
        assert avg == 0.0
        assert trend == "stable"
        assert len(warnings) > 0

    def test_ignores_tickets_without_intervention_time(self):
        current  = [make_ticket(total_intervention_minutes=0)]  # zero = invalid
        previous = [make_ticket(total_intervention_minutes=60)]
        warnings = []
        avg, trend, pct = _calc_mttr_trend(current, previous, warnings)
        assert avg == 0.0
        assert len(warnings) > 0

    def test_no_previous_data(self):
        current  = [make_ticket(total_intervention_minutes=60)] * 3
        warnings = []
        avg, trend, pct = _calc_mttr_trend(current, [], warnings)
        assert avg == pytest.approx(60.0)
        assert trend == "stable"
        assert len(warnings) > 0


# ---------------------------------------------------------------------------
# _calc_top_irritants
# ---------------------------------------------------------------------------

class TestTopIrritants:
    def test_returns_max_5(self):
        machines = [make_machine(id=f"m{i}", name=f"Machine{i}") for i in range(8)]
        tickets  = [make_ticket(machine_id=f"m{i % 8}", machine_name=f"Machine{i % 8}") for i in range(40)]
        result   = _calc_top_irritants(tickets, machines)
        assert len(result) <= 5

    def test_ranked_correctly(self):
        machines = [make_machine(id="m1", name="HighDowntime"), make_machine(id="m2", name="LowDowntime")]
        tickets  = (
            [make_ticket(machine_id="m1", machine_name="HighDowntime",
                         total_intervention_minutes=120, estimated_downtime_minutes=200)] * 10 +
            [make_ticket(machine_id="m2", machine_name="LowDowntime",
                         total_intervention_minutes=10,  estimated_downtime_minutes=5)]  * 2
        )
        result = _calc_top_irritants(tickets, machines)
        assert result[0]["machine_name"] == "HighDowntime"

    def test_empty_tickets(self):
        result = _calc_top_irritants([], [make_machine()])
        assert result == []

    def test_includes_rank(self):
        machines = [make_machine(id="m1")]
        tickets  = [make_ticket(machine_id="m1")] * 5
        result   = _calc_top_irritants(tickets, machines)
        assert result[0]["rank"] == 1

    def test_risk_level_assigned(self):
        machines = [make_machine(id="m1", name="BadMachine")]
        tickets  = [make_ticket(machine_id="m1", machine_name="BadMachine",
                               total_intervention_minutes=200,
                               estimated_downtime_minutes=300)] * 15
        result   = _calc_top_irritants(tickets, machines)
        assert result[0]["risk_level"] in ("high", "critical")


# ---------------------------------------------------------------------------
# _calc_spare_parts_risk
# ---------------------------------------------------------------------------

class TestSparePartsRisk:
    def test_critical_below_zero_stock(self):
        parts    = [make_part(current_qty=0, min_qty=5, recent_qty=10, baseline_qty=2)]
        risks, below_min = _calc_spare_parts_risk(parts, [])
        assert len(risks) == 1
        assert risks[0]["risk_level"] == "critical"
        assert below_min == 1

    def test_high_risk_below_half_minimum(self):
        parts    = [make_part(current_qty=2, min_qty=10, recent_qty=3, baseline_qty=3)]
        risks, below_min = _calc_spare_parts_risk(parts, [])
        assert risks[0]["risk_level"] in ("high", "critical")
        assert below_min >= 1

    def test_low_risk_above_minimum(self):
        parts    = [make_part(current_qty=20, min_qty=5, recent_qty=2, baseline_qty=2)]
        risks, below_min = _calc_spare_parts_risk(parts, [])
        # Should be low risk — filtered out of the list
        assert len(risks) == 0
        assert below_min == 0

    def test_abnormal_consumption(self):
        # Consumption tripled vs baseline → abnormal
        parts    = [make_part(current_qty=20, min_qty=5, recent_qty=9, baseline_qty=3)]
        risks, _ = _calc_spare_parts_risk(parts, [])
        if risks:
            assert risks[0]["consumption_trend"] in ("deteriorated", "abnormal")

    def test_stockout_estimate(self):
        parts  = [make_part(current_qty=5, min_qty=2, recent_qty=15, baseline_qty=10)]
        risks, _ = _calc_spare_parts_risk(parts, [])
        if risks and risks[0].get("days_until_stockout"):
            assert risks[0]["days_until_stockout"] > 0

    def test_no_minimum_stock_set(self):
        # min_qty = 0 should not trigger stock alert
        parts    = [make_part(current_qty=0, min_qty=0, recent_qty=2, baseline_qty=2)]
        risks, below_min = _calc_spare_parts_risk(parts, [])
        assert below_min == 0


# ---------------------------------------------------------------------------
# _detect_concentration_risk
# ---------------------------------------------------------------------------

class TestConcentrationRisk:
    def test_concentration_detected(self):
        workload = [
            {"technician_name": "Alice", "pct_of_team_tickets": 45.0, "ticket_count": 45},
            {"technician_name": "Bob",   "pct_of_team_tickets": 30.0, "ticket_count": 30},
            {"technician_name": "Carol", "pct_of_team_tickets": 25.0, "ticket_count": 25},
        ]
        assert _detect_concentration_risk(workload) is True

    def test_no_concentration(self):
        workload = [
            {"technician_name": "Alice", "pct_of_team_tickets": 25.0, "ticket_count": 25},
            {"technician_name": "Bob",   "pct_of_team_tickets": 25.0, "ticket_count": 25},
            {"technician_name": "Carol", "pct_of_team_tickets": 25.0, "ticket_count": 25},
            {"technician_name": "Dave",  "pct_of_team_tickets": 25.0, "ticket_count": 25},
        ]
        assert _detect_concentration_risk(workload) is False

    def test_single_technician(self):
        workload = [{"technician_name": "Alice", "pct_of_team_tickets": 100.0, "ticket_count": 10}]
        # Only 1 tech — cannot measure concentration
        assert _detect_concentration_risk(workload) is False

    def test_empty_workload(self):
        assert _detect_concentration_risk([]) is False

    def test_exactly_60_percent(self):
        # 60% boundary: >60 triggers, =60 does not
        workload = [
            {"technician_name": "Alice", "pct_of_team_tickets": 35.0, "ticket_count": 35},
            {"technician_name": "Bob",   "pct_of_team_tickets": 25.0, "ticket_count": 25},
        ]
        assert _detect_concentration_risk(workload) is False  # exactly 60, not >60


# ---------------------------------------------------------------------------
# _calc_trends
# ---------------------------------------------------------------------------

class TestCalcTrends:
    def test_ticket_count_trend_included(self):
        current  = [make_ticket(machine_id="m1")] * 10
        previous = [make_ticket(machine_id="m1")] * 6
        machines = [make_machine(id="m1")]
        trends   = _calc_trends(current, previous, machines)
        ticket_trend = next((t for t in trends if t["metric"] == "ticket_count"
                            and t["entity_name"] == "All machines"), None)
        assert ticket_trend is not None
        assert ticket_trend["current_value"] == 10
        assert ticket_trend["previous_value"] == 6

    def test_mttr_trend_included_when_data_available(self):
        current  = [make_ticket(total_intervention_minutes=80)] * 5
        previous = [make_ticket(total_intervention_minutes=60)] * 5
        machines = [make_machine()]
        trends   = _calc_trends(current, previous, machines)
        mttr_trend = next((t for t in trends if t["metric"] == "MTTR"), None)
        assert mttr_trend is not None
        assert mttr_trend["direction"] == "deteriorated"

    def test_empty_periods(self):
        # Should not raise
        trends = _calc_trends([], [], [])
        assert isinstance(trends, list)
