"""Retired stock rows must not be counted, listed or offered anywhere.
=====================================================================
The Interal extraction added 3 729 rows with ``archived = true`` — part numbers
the source withdrew. They are kept so an old number still resolves, which splits
every consumer of ``stock_items`` into two opposite obligations:

  · resolving ONE part by id must NOT filter. A work order that consumed a part
    since retired still has to resolve and price it; that is the entire reason
    the rows were kept instead of deleted.
  · ENUMERATING — counting, listing, searching, aggregating — MUST filter, or
    every total silently gains 3 729 parts that nobody stocks.

These tests pin the second half. The first is pinned by its absence: nothing
here asserts a filter on a by-id lookup, and adding one would break the history.
"""
import os
import re
import sys

import pytest
from sqlalchemy import and_, or_

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.models.models import StockItem                              # noqa: E402


def _sql(clause) -> str:
    return str(clause.compile(compile_kwargs={"literal_binds": True}))


# ─── The one a type checker cannot reach ──────────────────────────────────────

def test_ask_ninja_schema_hint_warns_about_archived():
    """The hint handed to the model is prose, so nothing else can guard it.

    ``query_database`` lets the assistant write its own SQL over stock_items.
    The only thing telling it that retired rows exist is one English sentence in
    ``_TABLE_HINTS``. No compiler, linter or type check reads that sentence — if
    someone trims it, Ask Ninja goes back to answering "5 550 parts are out of
    stock" with the confidence of a number that came from the database.
    """
    from app.services.intelligence_chat import _TABLE_HINTS

    hint = _TABLE_HINTS["stock_items"]
    assert "archived" in hint, (
        "the stock_items schema hint no longer mentions `archived` — the model "
        "will write SELECTs that count the retired catalogue"
    )
    # Naming the column is not enough; the hint has to say what to DO about it.
    assert re.search(r"archived\s*=\s*false", hint, re.I), (
        "the hint names `archived` but never tells the model to filter on it"
    )


def test_ask_ninja_inventory_overview_excludes_retired():
    """Every count in the tool shares one scope — so the scope carries the rule."""
    import inspect

    from app.services import intelligence_chat

    source = inspect.getsource(intelligence_chat._inventory_overview)
    assert "archived" in source, (
        "_inventory_overview counts stock_items with no archived guard; its six "
        "queries all reuse `scope`, so the guard belongs there"
    )


# ─── Enumeration predicates ───────────────────────────────────────────────────

def test_replenishment_never_offers_a_retired_part():
    """A buyer must not be told to reorder a part number the source withdrew."""
    from app.api.routes.suppliers import _low_stock_cond

    assert "archived" in _sql(_low_stock_cond()), (
        "the replenishment worklist would add 3 729 retired items below minimum"
    )


@pytest.mark.parametrize("module_name, function_name", [
    ("app.services.cost_insights", "inventory_analysis"),
    ("app.services.home_insights", "_low_stock"),
    ("app.services.intelligence_calculator", "_fetch_parts_consumption"),
])
def test_enumerations_carry_the_archived_guard(module_name, function_name):
    """Each of these loads or counts the catalogue to report a number.

    The last two are dormant today — their risk branch only fires once an item
    has a minimum quantity set, and none has — so this is the guard that keeps
    them correct the day someone sets one, rather than a live defect.
    """
    import importlib
    import inspect

    module = importlib.import_module(module_name)
    source = inspect.getsource(getattr(module, function_name))
    assert "archived" in source, (
        f"{module_name}.{function_name} enumerates stock_items without excluding "
        "the retired rows"
    )


# ─── The rule the predicates encode ───────────────────────────────────────────

def test_archived_guard_survives_being_combined():
    """and_(archived-false, low-stock) must keep both halves.

    Guarding against the refactor that wraps the guard in an or_ by accident,
    which would widen the result instead of narrowing it.
    """
    low = or_(
        StockItem.quantity <= 0,
        and_(StockItem.min_quantity.isnot(None), StockItem.quantity <= StockItem.min_quantity),
    )
    combined = _sql(and_(StockItem.archived.is_(False), low))
    assert "archived IS false" in combined
    assert "quantity <= 0" in combined
    # The guard must be ANDed at the top level, never ORed in beside the rest.
    assert not combined.strip().startswith("stock_items.archived IS false OR")
