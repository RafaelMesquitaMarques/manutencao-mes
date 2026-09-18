"""Interal xlsx import — the decisions that would silently corrupt the catalogue.
==============================================================================
The importer's risky parts are not the SQL, they are the judgements it makes
about a messy export: which broken rows it dares rebuild, which cells it refuses
to believe, and which of its own values must never overwrite the platform's.
Every test here pins one of those, and needs no database.

  · mojibake is repaired, and correct text is left exactly as it is
  · a split record is rebuilt ONLY when the un-shifted row still reads like a
    product row — a wrong shift would swap a part's quantity with its price
  · a record that lost its tail contributes identity and nothing else
  · an empty cell is silence, never an erase
  · Interal's 0 average price is "never bought", not "costs nothing"
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))

import import_inventory_xlsx as imp                                # noqa: E402

H = imp.EXPECTED_HEADERS
C = imp.COLUMN


def row(**values):
    """A physical sheet row, given by column name."""
    cells = [None] * len(H)
    for name, value in values.items():
        cells[C[name]] = value
    return cells


def intact(**overrides):
    base = dict(
        ID_PRODUCT=4446, NO_PRODUCT="PA-0001496", PRODUCT_NAME="BOUT-PUSH-0038",
        DESCRIPTION="TELEMECANIQUE ZB5AA3", NO_PART_CATEGORY="electrique",
        QUANTITY_AVAILABLE=-2, AVERAGE_UNIT_PRICE=8.36, QUANTITY=-2,
        TOTAL_SALE_PRICE=0, UNIT_STORAGE="Unitaire", ID_UNIT_STORAGE=4,
        ID_UNIT_UTIL=4, UNIT_UTIL="Unitaire", QUOTED_PROFIT=0,
        SALE_PRICE_EDITABLE=0, F_USE_EDITABLE_SALE_PRICE=0, F_SERIAL_NUMBER=0,
        F_BATCH_NUMBER=0, F_STOCKABLE=1, NO_PART_CLASS="bouton/button",
        location="Mag1 - I4D", SUPPLIER="2000000090 - Futech A.S.C. Inc",
        F_STOCKABLE1=1,
    )
    base.update(overrides)
    return row(**base)


# ─── Encoding ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("broken, fixed", [
    ("clavette ou clÃ©", "clavette ou clé"),
    ("Ã©lÃ©ment chauffant", "élément chauffant"),
    ("QtÃ© min:   1", "Qté min:   1"),
    ("Ã‰lectro-Mag", "Électro-Mag"),          # 0x89 → cp1252, not latin-1
    ("Bac Ã\xa0 colle", "Bac à colle"),
])
def test_mojibake_is_repaired(broken, fixed):
    assert imp.demojibake(broken) == fixed


@pytest.mark.parametrize("text", [
    "câble", "élément chauffant", "Précimix (Kremlin)", "MEGADYNE T150-41.0M-075",
    "unité de fine trimming", "Réservoir à vacuum",
])
def test_correct_text_is_left_alone(text):
    """The round-trip must be a no-op on text that was never mangled."""
    assert imp.demojibake(text) == text


# ─── Splitting the source's compound fields ───────────────────────────────────

def test_location_splits_into_warehouse_and_bin():
    assert imp.split_location("Mag1 - AA6C") == ("Mag1", "AA6C")
    assert imp.split_location("Mag 3 - Z6C") == ("Mag 3", "Z6C")


def test_location_without_a_separator_is_all_bin():
    """Inventing a warehouse out of an unsplittable string would be worse."""
    assert imp.split_location("Mezz-A2") == (None, "Mezz-A2")
    assert imp.split_location(None) == (None, None)


def test_supplier_splits_on_either_spacing():
    assert imp.split_supplier("2000000090 - Futech A.S.C. Inc") == ("2000000090", "Futech A.S.C. Inc")
    assert imp.split_supplier("0012-SCM Group") == ("0012", "SCM Group")


def test_reference_fields_drop_the_placeholder_zero():
    assert imp.reference_text("PO 4500052192") == "PO 4500052192"
    assert imp.reference_text(0) is None
    assert imp.reference_text(None) is None


def test_zero_average_price_is_not_a_price():
    """Interal writes 0 for a part it never bought. Storing it would make a third
    of the catalogue cost $0.00 on every work order that consumes it."""
    assert imp.average_price(8.36) == 8.36
    assert imp.average_price(0) is None
    assert imp.average_price(None) is None


# ─── Structural repair ────────────────────────────────────────────────────────

def test_a_clean_sheet_yields_one_record_per_row():
    records, stats = imp.assemble([(2, intact()), (3, intact(NO_PRODUCT="PA-0000002"))])
    assert [r.status for r in records] == ["intact", "intact"]
    assert stats["truncated"] == 0


def test_split_record_is_rebuilt_from_its_tail():
    """Row 5209 + blank 5210 + shifted tail 5211 is one product, not three rows."""
    head = row(ID_PRODUCT=10523, NO_PRODUCT="PA-0005536",
               PRODUCT_NAME="ENCO-UNIT-0002", DESCRIPTION="208746 DFS60E S4")
    tail = [None] * len(H)
    tail[0] = 'Encodeur de chariot pousseur schelling 4"'
    for index, value in enumerate([
        "electrique", None, 0, 784.4802, 0, 784.4802, None, None, "Unitaire",
        4, 4, "Unitaire", 1, 0, 0, 0, 0, 1, "encodeur", None, None, None,
        "2000000143 - Schelling America Inc", None, 1,
    ], start=1):
        tail[index] = value

    records, stats = imp.assemble([(5209, head), (5210, [None] * len(H)), (5211, tail)])

    assert stats["spliced"] == 1 and stats["truncated"] == 0
    item = imp.build_item(records[0])
    assert item["code"] == "PA-0005536"
    assert item["average_cost"] == 784.4802
    assert item["quantity"] == 0.0
    assert item["part_class"] == "encodeur"
    assert item["supplier_code"] == "2000000143"
    # The blank row between the two halves is an empty LINE of the description.
    assert item["description"] == '208746 DFS60E S4\n\nEncodeur de chariot pousseur schelling 4"'


def test_a_tail_that_does_not_line_up_is_refused():
    """Rather than shift a row into nonsense, leave it flagged as incomplete."""
    head = row(ID_PRODUCT=1, NO_PRODUCT="PA-0000001", DESCRIPTION="head")
    tail = [None] * len(H)
    tail[0] = "tail text"
    tail[1] = "electrique"
    # UNIT_STORAGE lands on garbage and the price invariant cannot hold.
    tail[C["TOTAL_SALE_PRICE"] - imp.CONTINUATION_SHIFT] = "not a unit"

    records, stats = imp.assemble([(2, head), (3, tail)])

    assert stats["splice_rejected"] == 1
    assert records[0].status == "truncated"


def test_a_record_with_no_tail_keeps_only_its_identity():
    head = row(ID_PRODUCT=2959, NO_PRODUCT="PA-0002124",
               PRODUCT_NAME="COUR-FLAT-0028", DESCRIPTION="MEGADYNE T150-41.0M")
    records, stats = imp.assemble([(2, head), (3, intact(NO_PRODUCT="PA-0002125"))])

    assert stats["truncated"] == 1
    item = imp.build_item(records[0])
    assert item["import_incomplete"] is True
    assert item["name"] == "COUR-FLAT-0028"
    assert item["interal_product_id"] == "2959"
    # The description is cut off at the line break, so it is not offered either.
    assert item["description"] is None
    assert "quantity" not in item and "average_cost" not in item


# ─── What an update is allowed to touch ───────────────────────────────────────

def _current(**overrides):
    base = {field: None for field in imp.SOURCE_OWNED}
    base.update({"quantity": 0.0, "archived": False, "import_incomplete": False})
    base.update(overrides)
    return base


def test_a_filled_cell_overwrites_the_platform():
    item = imp.build_item(imp.SourceRow(2, intact(), "intact"))
    changes = imp.plan_update(item, _current(average_cost=99.0, category="wrong"))
    assert changes["average_cost"] == 8.36
    assert changes["category"] == "electrique"


def test_an_empty_cell_never_erases():
    """The sheet is silent about this part's category; the platform's stands."""
    item = imp.build_item(imp.SourceRow(2, intact(NO_PART_CATEGORY=None, DATA01=None), "intact"))
    changes = imp.plan_update(item, _current(category="electrique", source_note="soum. 2020"))
    assert "category" not in changes
    assert "source_note" not in changes


def test_an_unchanged_row_plans_nothing():
    """Re-running the same extraction must be a no-op, or every run rewrites
    the whole catalogue and re-stamps 10 000 rows."""
    item = imp.build_item(imp.SourceRow(2, intact(), "intact"))
    current = _current(**{
        field: item.get(field) for field in imp.SOURCE_OWNED + imp.ALWAYS_SET
    })
    assert imp.plan_update(item, current) == {}


def test_a_truncated_row_cannot_move_a_quantity_or_a_cost():
    head = row(ID_PRODUCT=2959, NO_PRODUCT="PA-0002124", PRODUCT_NAME="COUR-FLAT-0028",
               DESCRIPTION="cut off")
    records, _ = imp.assemble([(2, head), (3, intact(NO_PRODUCT="PA-0002125"))])
    item = imp.build_item(records[0])

    changes = imp.plan_update(item, _current(
        description="the full description the platform already has",
        average_cost=34.48, category="mecanique", location="J2D",
    ))

    assert set(changes) <= {"name", "interal_product_id", "import_incomplete"}
    assert changes["import_incomplete"] is True


def test_retired_part_numbers_are_flagged_not_dropped():
    item = imp.build_item(imp.SourceRow(2, intact(NO_PRODUCT="xPA-0002124"), "intact"))
    assert item["code"] == "xPA-0002124"      # prefix and case preserved
    assert item["archived"] is True


@pytest.mark.parametrize("code", ["PA-0001496", "xPA-0002124", "pa-0005473", "0000645057B"])
def test_part_numbers_are_taken_verbatim(code):
    """Leading zeros, case and prefix are part of the identity, not noise."""
    item = imp.build_item(imp.SourceRow(2, intact(NO_PRODUCT=code), "intact"))
    assert item["code"] == code


def test_negative_and_fractional_balances_survive():
    item = imp.build_item(imp.SourceRow(2, intact(QUANTITY=-20.23, QUANTITY_AVAILABLE=-20.23), "intact"))
    assert item["quantity"] == -20.23
    assert item["quantity_available"] == -20.23
