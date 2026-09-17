"""Cost-control arithmetic: cut-off, period-coherent variance, projection.
==========================================================================
These are the calculations the Costs page reads for its headline numbers, so
they are tested as pure functions on a hand-built CostContext — no DB, no
fixtures, every input visible in the test.

What is pinned here:

  · the CUT-OFF is the ledger's, not the calendar's. A trailing month posting a
    token amount next to full months is `partial`; an elapsed month with nothing
    posted is `awaiting`, never a month that cost nothing;
  · the variance compares budget and actual over the SAME months (to the
    cut-off). The annual envelope minus a partial actual is the remaining
    balance and is reported separately — the bug this module exists to fix;
  · the projection reconciles: the per-slot forecast plus the overdue
    commitments equal the headline total, so the landing chart and the card
    cannot disagree;
  · an open commitment never stacks on top of the budget of its own month
    (max, not sum), while a commitment expected in an already-closed month is
    carried on top of the cut-off — it never reached the ledger.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.api.routes.costs import Scope                     # noqa: E402
from app.services.cost_control import (                    # noqa: E402
    AWAITING, CLOSED, FUTURE, PARTIAL, CostContext, compute_as_of, compute_forecast,
)


def make_ctx(budget, actual, committed=None, adjustments=None,
             fiscal=True, source="sap", year=2026):
    """A 12-slot fiscal context (Dec of year-1 … Nov of year)."""
    mmap = [(year - 1, 12)] + [(year, m) for m in range(1, 12)]
    zeros = [0.0] * 12
    return CostContext(
        year=year, scope=Scope(site=None), fiscal=fiscal, source=source, mmap=mmap,
        budget={"opex": list(budget), "capex": list(zeros)},
        actual={"opex": list(actual), "capex": list(zeros)},
        tracked={"opex": list(zeros), "capex": list(zeros)},
        committed={"opex": list(committed or zeros), "capex": list(zeros)},
        adjustments={"opex": list(adjustments or zeros), "capex": list(zeros)},
        site_ids={},
    )


# Production shape of FY2026 as imported on 2026-07-06: twelve budgeted months,
# seven fully posted, July posting a token $784, August..November empty.
FY26_BUDGET = [78719, 94382, 93142, 98678, 92141, 86403, 90286,
               97267, 75736, 88624, 98477, 95791]
FY26_ACTUAL = [79186, 112771, 153675, 173789, 163011, 59059, 97081,
               784, 0, 0, 0, 0]


class FrozenToday(CostContext):
    """CostContext whose 'today' is pinned, so the cut-off is deterministic."""
    pinned = None

    @property
    def today(self):
        return self.pinned


def ctx_on(day, **kw):
    import datetime
    c = make_ctx(**kw)
    frozen = FrozenToday(**{f.name: getattr(c, f.name) for f in c.__dataclass_fields__.values()})
    frozen.pinned = datetime.date.fromisoformat(day)
    return frozen


# ─── Cut-off ─────────────────────────────────────────────────────────────────

def test_token_posting_is_partial_not_closed():
    """July posts $784 against a ~$120k monthly average — the month is not
    closed, and the run rate must not be dragged down by it."""
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    assert as_of["last_closed_slot"] == 7          # June 2026
    assert as_of["partial_slot"] == 8              # July 2026, token amount
    assert as_of["cutoff_period"] == {"year": 2026, "month": 7}
    assert as_of["method"] == "sap_posted"


def test_elapsed_months_without_posting_are_awaiting_not_zero():
    """August and September happened. Nothing was imported for them — that is a
    data gap, not two months that cost nothing."""
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    assert as_of["slot_status"][8] == AWAITING     # slot 9 = Aug 2026
    assert as_of["slot_status"][9] == AWAITING     # slot 10 = Sep 2026
    assert as_of["awaiting_slots"] == [9, 10]
    assert as_of["unposted_elapsed_months"] == 2
    assert as_of["slot_status"][10] == FUTURE      # October is still ahead
    assert as_of["slot_status"][:7] == [CLOSED] * 7
    assert as_of["slot_status"][7] == PARTIAL


def test_platform_tracked_year_cuts_off_at_today():
    c = ctx_on("2026-09-16", budget=[1000] * 12, actual=[900] * 12,
               fiscal=False, source="internal")
    as_of = compute_as_of(c, "opex")
    assert as_of["method"] == "run_rate"
    # Fiscal map: slot 10 is September, the running month.
    assert as_of["partial_slot"] == 10
    assert as_of["last_closed_slot"] == 9
    assert AWAITING not in as_of["slot_status"]


# ─── Period-coherent variance ────────────────────────────────────────────────

def test_variance_compares_the_same_months():
    """The regression this module fixes: the full-year budget minus a partial
    actual read as a $250k FAVOURABLE variance, while the same months actually
    ran $108k OVER."""
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    f = compute_forecast(c, "opex", list(range(1, 13)), as_of)

    assert f["budget_to_date"] == pytest.approx(sum(FY26_BUDGET[:8]))
    assert f["actual_to_date"] == pytest.approx(sum(FY26_ACTUAL[:8]))
    assert f["variance_to_date"] < 0                       # over budget
    assert f["variance_to_date"] == pytest.approx(-108338.0, abs=1)

    # The leftover envelope is still reported — under its own name.
    assert f["remaining_budget"] == pytest.approx(
        sum(FY26_BUDGET) - sum(FY26_ACTUAL), abs=1)
    assert f["remaining_budget"] > 0                       # and it is NOT the variance


def test_run_rate_ignores_unposted_months():
    """Averaging over the closed months only — counting August and September as
    zero would halve the rate and hide the overrun."""
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    f = compute_forecast(c, "opex", list(range(1, 13)), as_of)
    assert f["run_rate"] == pytest.approx(sum(FY26_ACTUAL[:7]) / 7, abs=1)


# ─── Projection ──────────────────────────────────────────────────────────────

def test_forecast_reconciles_slot_by_slot():
    """The headline total must equal the blocks the landing chart draws."""
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    months = list(range(1, 13))
    f = compute_forecast(c, "opex", months, as_of)
    base = f["scenarios"]["base"]
    assert f["forecast"] == pytest.approx(
        sum(s["forecast"] for s in base["slots"]) + base["overdue_committed"], abs=0.01)


def test_closed_months_keep_their_actual_and_partial_tops_up():
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    slots = compute_forecast(c, "opex", list(range(1, 13)), as_of)["slots"]
    assert slots[0]["forecast"] == pytest.approx(FY26_ACTUAL[0])     # closed
    assert slots[7]["forecast"] == pytest.approx(FY26_BUDGET[7])     # partial → budget
    # An awaiting month takes the higher of plan and observed pace.
    assert slots[8]["forecast"] >= FY26_BUDGET[8]


def test_commitment_does_not_stack_on_its_own_month_budget():
    """A PO expected in a future month consumes that month's budget; it does not
    add to it. Only the part above the budget lifts the projection."""
    committed = [0.0] * 12
    committed[10] = 50_000                                  # October, budget 98 477
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL, committed=committed)
    as_of = compute_as_of(c, "opex")
    slots = compute_forecast(c, "opex", list(range(1, 13)), as_of)["slots"]
    assert slots[10]["forecast"] == pytest.approx(FY26_BUDGET[10])   # max(budget, PO)

    committed[10] = 150_000                                 # now above the budget
    c2 = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL, committed=committed)
    slots2 = compute_forecast(c2, "opex", list(range(1, 13)), compute_as_of(c2, "opex"))["slots"]
    assert slots2[10]["forecast"] == pytest.approx(150_000)


def test_overdue_commitment_is_carried_on_top_of_a_closed_month():
    """A PO expected in a closed month never reached that month's actual, so it
    is still ahead of us — carried on top, which is not double counting."""
    committed = [0.0] * 12
    committed[2] = 20_000                                   # February, long closed
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL, committed=committed)
    as_of = compute_as_of(c, "opex")
    f = compute_forecast(c, "opex", list(range(1, 13)), as_of)
    assert f["scenarios"]["base"]["overdue_committed"] == pytest.approx(20_000)
    assert f["slots"][2]["forecast"] == pytest.approx(FY26_ACTUAL[2])   # actual untouched

    plain = compute_forecast(
        ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL), "opex",
        list(range(1, 13)), as_of)
    assert f["forecast"] - plain["forecast"] == pytest.approx(20_000, abs=1)


def test_adjustment_moves_only_the_forecast():
    adj = [0.0] * 12
    adj[10] = 75_000
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL, adjustments=adj)
    as_of = compute_as_of(c, "opex")
    f = compute_forecast(c, "opex", list(range(1, 13)), as_of)
    plain = compute_forecast(
        ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL), "opex",
        list(range(1, 13)), as_of)
    assert f["forecast"] - plain["forecast"] == pytest.approx(75_000, abs=1)
    assert f["annual_budget"] == plain["annual_budget"]       # budget untouched
    assert f["actual_to_date"] == plain["actual_to_date"]     # actual untouched
    assert f["adjustments_total"] == pytest.approx(75_000)


def test_scenarios_are_ordered_and_share_the_closed_months():
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    f = compute_forecast(c, "opex", list(range(1, 13)), as_of)
    s = f["forecast_scenarios"]
    assert s["favorable"] <= s["base"] <= s["unfavorable"]
    for name in ("favorable", "base", "unfavorable"):
        closed = f["scenarios"][name]["slots"][:7]
        assert [x["forecast"] for x in closed] == pytest.approx(FY26_ACTUAL[:7])


def test_a_fully_closed_period_has_no_projection_gap():
    """When every month is closed the projection is just the actual — the old
    page arithmetic and the new one agree exactly, as they must."""
    actual = [1000.0] * 12
    c = ctx_on("2027-06-15", budget=[1200] * 12, actual=actual)   # FY2026 is over
    as_of = compute_as_of(c, "opex")
    f = compute_forecast(c, "opex", list(range(1, 13)), as_of)
    assert as_of["last_closed_slot"] == 12
    assert f["forecast"] == pytest.approx(sum(actual))
    assert f["variance_to_date"] == pytest.approx(f["period_budget"] - f["period_actual"])


def test_period_slice_only_counts_the_selected_months():
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=FY26_ACTUAL)
    as_of = compute_as_of(c, "opex")
    q = compute_forecast(c, "opex", [2, 3, 4], as_of)             # Jan–Mar 2026
    assert q["period_budget"] == pytest.approx(sum(FY26_BUDGET[1:4]))
    assert q["period_actual"] == pytest.approx(sum(FY26_ACTUAL[1:4]))
    assert q["budget_to_date"] == q["period_budget"]               # all closed
    assert q["forecast"] == pytest.approx(sum(FY26_ACTUAL[1:4]))


def test_a_zero_month_inside_the_posted_range_stays_closed():
    """A month that genuinely cost nothing is NOT the same as a month that was
    never imported. Only trailing gaps are `awaiting`; an interior zero sits
    inside the closed range and is projected at its own actual."""
    actual = list(FY26_ACTUAL)
    actual[3] = 0.0                                  # March 2026 really cost nothing
    c = ctx_on("2026-09-16", budget=FY26_BUDGET, actual=actual)
    as_of = compute_as_of(c, "opex")
    assert as_of["slot_status"][3] == CLOSED
    assert as_of["awaiting_slots"] == [9, 10]        # unchanged: still the trailing gap
    slots = compute_forecast(c, "opex", list(range(1, 13)), as_of)["slots"]
    assert slots[3]["forecast"] == 0.0               # not topped up to its budget
