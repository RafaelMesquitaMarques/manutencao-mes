"""
Tests for the PM occurrence override contract.
=============================================
Guards the fix that lets a client CLEAR an override_date (explicit null),
not just set it. No DB/HTTP needed — it exercises the schema's field-set
detection plus the handler's override-application rule.
Run with: pytest backend/tests/test_occurrence_override.py -v
"""

import sys
import os
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'backend'))

from app.schemas.pm import OccurrenceOverride


def _apply(occ: dict, data: OccurrenceOverride) -> dict:
    """Mirror override_occurrence(): only touch fields the client actually sent,
    then recompute is_overridden from the final state."""
    fields_set = data.model_fields_set
    if "override_date" in fields_set:
        occ["override_date"] = data.override_date  # date, or None to clear
    if "override_note" in fields_set:
        occ["override_note"] = data.override_note
    occ["is_overridden"] = bool(occ["override_date"] or occ["override_note"])
    return occ


def test_omitted_override_date_is_untouched():
    # Editing only the note must NOT wipe an existing override_date.
    data = OccurrenceOverride(override_note="adjusted")
    assert "override_date" not in data.model_fields_set
    occ = _apply(
        {"override_date": date(2026, 6, 20), "override_note": None, "is_overridden": True},
        data,
    )
    assert occ["override_date"] == date(2026, 6, 20)
    assert occ["is_overridden"] is True


def test_explicit_null_clears_override_date():
    # The bug: {"override_date": null} must clear the override and reset the flag.
    data = OccurrenceOverride.model_validate({"override_date": None})
    assert "override_date" in data.model_fields_set
    assert data.override_date is None
    occ = _apply(
        {"override_date": date(2026, 6, 20), "override_note": None, "is_overridden": True},
        data,
    )
    assert occ["override_date"] is None
    assert occ["is_overridden"] is False


def test_clearing_date_keeps_overridden_when_note_remains():
    data = OccurrenceOverride.model_validate({"override_date": None})
    occ = _apply(
        {"override_date": date(2026, 6, 20), "override_note": "keep me", "is_overridden": True},
        data,
    )
    assert occ["override_date"] is None
    assert occ["is_overridden"] is True  # a note still counts as an override


def test_setting_a_date_marks_overridden():
    data = OccurrenceOverride.model_validate({"override_date": "2026-06-25"})
    occ = _apply(
        {"override_date": None, "override_note": None, "is_overridden": False},
        data,
    )
    assert occ["override_date"] == date(2026, 6, 25)
    assert occ["is_overridden"] is True
