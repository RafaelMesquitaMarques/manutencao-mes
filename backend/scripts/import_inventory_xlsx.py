#!/usr/bin/env python3
"""
scripts/import_inventory_xlsx.py
Refresh the stock catalogue from an Interal inventory extraction (.xlsx).

This supersedes scripts/import_inventory.py (Inventory.xml), which had no price,
no supplier, no product name and no stockable flag to import. The extraction is
the system of record: where it disagrees with the platform, IT wins.

Run it in a throwaway container with the extraction's folder mounted, so the
report and its change log land on the host — nothing written inside mes_backend
survives the next `docker compose up --build`:

    # preview — writes the report, touches nothing
    docker run --rm --network manutencao-mes_default -v "<folder>:/data" \
        -e DATABASE_URL="$(docker exec mes_backend printenv DATABASE_URL)" \
        manutencao-mes-backend python /app/scripts/import_inventory_xlsx.py \
        --file /data/170926_inventory.xlsx --plant QS --report /data/import_report.md

    # apply — same command plus --apply
    #   ... --plant QS --apply --report /data/import_report.md

The report is written either way; `--apply` is the only thing that writes to the
database, so the preview is the diff you approve before it runs.

Rules the import obeys
──────────────────────
* Balances are SET to the sheet's value, never added to it, and the delta is
  written to inventory_movements as an `adjustment` so the history survives and
  nothing is counted twice. Re-running the same file moves nothing.
* An EMPTY cell is not an instruction to erase. Only a filled cell overwrites.
* Fields the platform owns and the sheet has no column for — min_quantity,
  unit_cost, notes, last_purchase_cost/date — are never touched.
* Items missing from the extraction are left alone, never deleted.
* Matching is by (plant, code). Codes keep their case, prefix and leading zeros:
  `PA-0001496`, `xPA-0002124` and `pa-0005473` are three different parts.

What the 31 columns become — and what is deliberately left out
─────────────────────────────────────────────────────────────
Mapped:
    ID_PRODUCT          → interal_product_id      NO_PRODUCT      → code
    PRODUCT_NAME        → name                    DESCRIPTION     → description
    NO_PART_CATEGORY    → category                NO_PART_CLASS   → part_class
    UNIT_STORAGE        → unit                    QUANTITY        → quantity
    QUANTITY_AVAILABLE  → quantity_available
    AVERAGE_UNIT_PRICE  → average_cost, except a 0, which is Interal's "never
                          priced" and would otherwise make a third of the
                          catalogue cost $0.00 on work orders (see average_price)
    location            → warehouse + location    (split on " - ": "Mag1 - AA6C")
    SUPPLIER            → supplier / supplier_code / supplier_id
    PREFERRED_SUPPLIER  → preferred_supplier / preferred_supplier_code
    NO_INVENTORY_CODE   → inventory_code          F_STOCKABLE     → stockable
    QUOTED_PROFIT       → sale_markup             DATA01          → source_note
    DRAWING_REVISION    → drawing_revision

Left out, each for a reason checked against the 10 010 rows of the 2026-09-17
extraction (the report restates this on every run):
    NO_EXPENSE_ACCOUNT_SET  0 of 10 010 cells filled — the column is empty.
    DESCRIPTION2            2 cells, both inside the two broken rows below.
    NO_PART_CODE            8 cells, all of them shifted values from broken rows
                            ("Qté min: 1", a supplier name) — not part codes.
    F_STOCKABLE1            identical to F_STOCKABLE in all 9 985 intact rows.
    UNIT_UTIL               identical to UNIT_STORAGE in all 9 985 intact rows.
    ID_UNIT_STORAGE/_UTIL   Interal's internal surrogate keys for those units.
    TOTAL_SALE_PRICE        equals AVERAGE_UNIT_PRICE × QUOTED_PROFIT in 9 985 of
                            9 985 rows. A derived SALE price — neither a unit
                            cost nor the value of the stock on hand.
    ID_CUSTOMER             not a supplier key: 21 supplier codes map to several
                            ID_CUSTOMER values and 26 ID_CUSTOMER values map to
                            several supplier codes. Linking on it would attach
                            parts to the wrong supplier.
    F_SERIAL_NUMBER         0 in every intact row.
    F_BATCH_NUMBER          1 in exactly one row of 9 985.
    SALE_PRICE_EDITABLE     non-zero on 12 rows; F_USE_EDITABLE_SALE_PRICE on 19.
                            Both are listed part-by-part in the report so the
                            handful of overridden prices is not lost silently.

Two data problems the file carries, both handled here
─────────────────────────────────────────────────────
1. Mojibake. 901 cells hold UTF-8 bytes that were read as Windows-1252 ("clÃ©",
   "QtÃ©", "Ã‰lectro-Mag"). Repaired by the round-trip, and only when it
   succeeds — text that is already correct is never touched.
2. Broken records. A line break inside DESCRIPTION split 23 records across
   physical rows. Two of them (PA-0005536, PA-0005537) have their tail on a
   later row, shifted exactly three columns left; those are spliced back and
   re-validated before use. The other 21 simply lost everything past the break:
   they are imported for identity only, flagged import_incomplete, and their
   numbers are left to whatever the platform already holds — a truncated row is
   not evidence that a count is zero.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import os
import re
import uuid
from collections import Counter
from datetime import date, datetime

import asyncpg
from openpyxl import load_workbook

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://mesadmin:mespassword@db:5432/manutencao",
)
PG_URL = re.sub(r"^postgresql\+\w+://", "postgresql://", DATABASE_URL)

EXPECTED_HEADERS = [
    "ID_PRODUCT", "NO_PRODUCT", "PRODUCT_NAME", "DESCRIPTION", "NO_PART_CATEGORY",
    "PREFERRED_SUPPLIER", "QUANTITY_AVAILABLE", "AVERAGE_UNIT_PRICE", "QUANTITY",
    "TOTAL_SALE_PRICE", "ID_CUSTOMER", "DESCRIPTION2", "UNIT_STORAGE",
    "ID_UNIT_STORAGE", "ID_UNIT_UTIL", "UNIT_UTIL", "QUOTED_PROFIT",
    "SALE_PRICE_EDITABLE", "F_USE_EDITABLE_SALE_PRICE", "F_SERIAL_NUMBER",
    "F_BATCH_NUMBER", "F_STOCKABLE", "NO_PART_CLASS", "NO_PART_CODE",
    "NO_INVENTORY_CODE", "location", "SUPPLIER", "NO_EXPENSE_ACCOUNT_SET",
    "F_STOCKABLE1", "DATA01", "DRAWING_REVISION",
]
COLUMN = {name: index for index, name in enumerate(EXPECTED_HEADERS)}

# A continuation row starts at column 1 with the tail of DESCRIPTION (column 4),
# so every field on it sits three columns to the left of where it belongs.
CONTINUATION_SHIFT = 3

KNOWN_UNITS = ("Unitaire", "Metre", "Pied", "boites", "kit", "pouces", "rouleau")


# ─── Cell hygiene ─────────────────────────────────────────────────────────────

_MOJIBAKE_MARK = re.compile(r"[ÃÂâ]")


def demojibake(value: str) -> str:
    """Undo one or more UTF-8-read-as-Windows-1252 passes, when it round-trips.

    "clÃ©" is the bytes of "clé" shown through the wrong codec, so encoding the
    string back to that codec and decoding it as UTF-8 restores it. Text that is
    already correct fails to decode ("câble" → b'c\\xe2ble', invalid UTF-8) and
    comes back untouched, which is what makes this safe to run over every cell.
    """
    for _ in range(3):                       # a few cells went through it twice
        if not _MOJIBAKE_MARK.search(value):
            return value
        for codec in ("cp1252", "latin-1"):  # cp1252 first: it maps 0x80-0x9F
            try:
                repaired = value.encode(codec).decode("utf-8")
            except (UnicodeEncodeError, UnicodeDecodeError):
                continue
            if repaired == value:
                return value
            value = repaired
            break
        else:
            return value
    return value


def clean(value):
    """Normalise one cell: repair encoding, trim, blank → None."""
    if value is None:
        return None
    if isinstance(value, str):
        return demojibake(value).strip() or None
    return value


def as_text(value, limit: int | None = None) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        text = value.date().isoformat()
    elif isinstance(value, date):
        text = value.isoformat()
    elif isinstance(value, float) and value == int(value):
        text = str(int(value))
    else:
        text = str(value).strip()
    if not text:
        return None
    return text[:limit] if limit else text


def as_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.replace(",", "."))
        except ValueError:
            return None
    return None


def as_flag(value):
    number = as_number(value)
    return None if number is None else bool(number)


def is_blank(value) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


# ─── Reading + structural repair ──────────────────────────────────────────────

class SourceRow:
    """One logical product, with a note on how intact its physical row was."""

    __slots__ = ("excel_row", "values", "status", "repair_note")

    def __init__(self, excel_row, values, status, repair_note=None):
        self.excel_row = excel_row
        self.values = values
        self.status = status            # intact | repaired | truncated
        self.repair_note = repair_note

    def cell(self, column):
        return clean(self.values[COLUMN[column]])


def read_sheet(path: str):
    workbook = load_workbook(path, read_only=True, data_only=True)
    sheet = workbook[workbook.sheetnames[0]]
    rows = sheet.iter_rows(values_only=True)
    headers = [h.strip() if isinstance(h, str) else h for h in next(rows)]
    if headers != EXPECTED_HEADERS:
        raise SystemExit(
            "Unexpected sheet layout — the importer maps columns by name and the "
            "header row does not match what it knows.\n"
            f"  expected: {EXPECTED_HEADERS}\n  found:    {headers}"
        )
    physical = [(n, list(values)) for n, values in enumerate(rows, start=2)]
    workbook.close()
    return physical


def looks_like_continuation(values) -> bool:
    """A tail row: column 1 holds prose (the rest of a DESCRIPTION), not an id."""
    head = values[0]
    return isinstance(head, str) and bool(head.strip()) and not head.strip().isdigit()


def splice(head_values, tail_values, blank_lines=0):
    """Rebuild one record from a head row and its shifted tail, or refuse to.

    The tail is only trusted when the un-shifted row reads like a product row: a
    known unit, a 0/1 stockable flag, and Interal's own invariant
    TOTAL_SALE_PRICE = AVERAGE_UNIT_PRICE × QUOTED_PROFIT. Applying a shift that
    does not hold would scramble a part's quantity and its cost into each other.
    """
    merged = list(head_values)
    # tail[0] is the rest of DESCRIPTION (column 4, index 3) and is merged into it
    # below, so the shift starts at tail[1] → NO_PART_CATEGORY.
    for index in range(1, len(EXPECTED_HEADERS) - CONTINUATION_SHIFT):
        target = index + CONTINUATION_SHIFT
        if target < len(merged) and index < len(tail_values):
            merged[target] = tail_values[index]

    unit = as_text(clean(merged[COLUMN["UNIT_STORAGE"]]))
    stockable = merged[COLUMN["F_STOCKABLE"]]
    average = as_number(merged[COLUMN["AVERAGE_UNIT_PRICE"]])
    markup = as_number(merged[COLUMN["QUOTED_PROFIT"]])
    total = as_number(merged[COLUMN["TOTAL_SALE_PRICE"]])

    if unit not in KNOWN_UNITS:
        return None, "unit did not land on a known unit after the shift"
    if stockable not in (0, 1):
        return None, "stockable flag did not land on 0/1 after the shift"
    if None in (average, markup, total) or abs(average * markup - total) > 0.02:
        return None, "sale price no longer equals average × markup after the shift"

    tail_description = as_text(clean(tail_values[0]))
    if tail_description:
        head_description = as_text(clean(merged[COLUMN["DESCRIPTION"]])) or ""
        # A fully blank physical row between head and tail is an empty LINE of the
        # description, not a row separator — keep it so the text comes back as it
        # was typed.
        separator = "\n" * (1 + blank_lines)
        merged[COLUMN["DESCRIPTION"]] = (
            f"{head_description}{separator}{tail_description}"
            if head_description else tail_description
        )
    return merged, None


def assemble(physical):
    """Physical rows → logical records, splicing tails and flagging casualties."""
    records: list[SourceRow] = []
    pending_head: SourceRow | None = None
    blank_run = 0
    stats = Counter()

    def abandon(head: SourceRow):
        head.status = "truncated"
        head.repair_note = "row ends at DESCRIPTION — no usable tail row in the file"

    for excel_row, values in physical:
        if all(is_blank(value) for value in values):
            stats["blank_rows"] += 1
            blank_run += 1
            continue

        if looks_like_continuation(values):
            stats["continuation_rows"] += 1
            if pending_head is None:
                stats["orphan_continuations"] += 1
                blank_run = 0
                continue
            merged, why = splice(pending_head.values, values, blank_run)
            if merged is None:
                pending_head.status = "truncated"
                pending_head.repair_note = f"tail found on sheet row {excel_row} but {why}"
                stats["splice_rejected"] += 1
            else:
                pending_head.values = merged
                pending_head.status = "repaired"
                pending_head.repair_note = (
                    f"rebuilt from sheet rows {pending_head.excel_row} + {excel_row}"
                )
                stats["spliced"] += 1
            pending_head = None
            blank_run = 0
            continue

        blank_run = 0
        # A new record starts here, so a head still open never got its tail.
        if pending_head is not None:
            abandon(pending_head)
            pending_head = None

        row = SourceRow(excel_row, values, "intact")
        records.append(row)
        # Cut short at DESCRIPTION: the record continues somewhere, or was lost.
        if all(is_blank(value) for value in values[COLUMN["NO_PART_CATEGORY"]:]):
            pending_head = row

    if pending_head is not None:
        abandon(pending_head)

    stats["truncated"] = sum(1 for row in records if row.status == "truncated")
    stats["records"] = len(records)
    return records, stats


# ─── Row → item ───────────────────────────────────────────────────────────────

SUPPLIER_TEXT = re.compile(r"^(\S+)\s*-\s*(.+)$")


def split_supplier(text: str | None):
    """"2000000090 - Futech A.S.C. Inc" → ("2000000090", "Futech A.S.C. Inc")."""
    if not text:
        return None, None
    match = SUPPLIER_TEXT.match(text)
    if not match:
        return None, text
    return match.group(1).strip() or None, match.group(2).strip() or None


def split_location(text: str | None):
    """"Mag1 - AA6C" → ("Mag1", "AA6C"), matching how the XML import stored it."""
    if not text:
        return None, None
    if " - " in text:
        warehouse, _, bin_code = text.partition(" - ")
        return warehouse.strip() or None, bin_code.strip() or None
    return None, text


def reference_text(value):
    """DATA01 / DRAWING_REVISION: free-text references, where a bare 0 says nothing."""
    text = as_text(value, 300)
    return None if text in (None, "0") else text


def average_price(value):
    """AVERAGE_UNIT_PRICE → average_cost, where Interal's 0 means "no average".

    3 063 rows carry 0 here, and they are parts nobody ever bought through
    Interal — not parts that cost nothing. Writing the 0 would hand
    part_pricing.unit_cost_of() a real price of $0.00 for a third of the
    catalogue, so every work-order line consuming one would cost zero instead of
    reading "no price". Treated as an empty cell instead: whatever the platform
    already knows (a purchase-derived average, say) is left standing.
    """
    number = as_number(value)
    return None if number in (None, 0.0) else number


def build_item(row: SourceRow) -> dict | None:
    code = as_text(row.cell("NO_PRODUCT"), 100)
    if not code:
        return None

    item = {
        "code": code,
        "excel_row": row.excel_row,
        "status": row.status,
        "repair_note": row.repair_note,
        # Interal retires a product by renaming it with an x. Corroborated, not
        # assumed from the prefix: every one of these has no stock, no location,
        # no product name and stockable=0, and 3 727 of 3 729 shadow a live part.
        "archived": code.lower().startswith("xpa-"),
        "import_incomplete": row.status == "truncated",
        "interal_product_id": as_text(row.cell("ID_PRODUCT"), 50),
        "name": as_text(row.cell("PRODUCT_NAME"), 300),
        "description": None,
    }

    if row.status == "truncated":
        # Everything past DESCRIPTION is missing and DESCRIPTION itself stops at
        # the line break, so only the identity fields above are trustworthy.
        return item

    supplier_code, supplier_name = split_supplier(as_text(row.cell("SUPPLIER"), 300))
    preferred_code, preferred_name = split_supplier(as_text(row.cell("PREFERRED_SUPPLIER"), 300))
    warehouse, location = split_location(as_text(row.cell("location"), 200))

    item.update({
        "description": as_text(row.cell("DESCRIPTION")),
        "category": as_text(row.cell("NO_PART_CATEGORY"), 200),
        "part_class": as_text(row.cell("NO_PART_CLASS"), 200),
        "unit": as_text(row.cell("UNIT_STORAGE"), 20),
        "quantity": as_number(row.cell("QUANTITY")),
        "quantity_available": as_number(row.cell("QUANTITY_AVAILABLE")),
        "average_cost": average_price(row.cell("AVERAGE_UNIT_PRICE")),
        "warehouse": warehouse,
        "location": location,
        "supplier": supplier_name,
        "supplier_code": supplier_code,
        "preferred_supplier": preferred_name,
        "preferred_supplier_code": preferred_code,
        "inventory_code": as_text(row.cell("NO_INVENTORY_CODE"), 100),
        "stockable": as_flag(row.cell("F_STOCKABLE")),
        "sale_markup": as_number(row.cell("QUOTED_PROFIT")),
        "drawing_revision": reference_text(row.cell("DRAWING_REVISION")),
        "source_note": reference_text(row.cell("DATA01")),
        # Kept out of the schema, surfaced in the report instead.
        "_sale_price_override": as_number(row.cell("SALE_PRICE_EDITABLE")),
        "_use_sale_price_override": as_flag(row.cell("F_USE_EDITABLE_SALE_PRICE")),
        "_batch_tracked": as_flag(row.cell("F_BATCH_NUMBER")),
    })
    return item


# ─── Diffing against the platform ─────────────────────────────────────────────

# Columns the extraction owns. A filled cell overwrites; an empty one is silence,
# not an erase instruction — so None never reaches the UPDATE.
SOURCE_OWNED = [
    "name", "description", "category", "part_class", "unit", "quantity_available",
    "average_cost", "warehouse", "location", "supplier", "supplier_code",
    "preferred_supplier", "preferred_supplier_code", "inventory_code", "stockable",
    "sale_markup", "drawing_revision", "source_note", "interal_product_id",
]
# Set on every run for every row: the importer computes these rather than reading
# them out of a cell that could be blank.
ALWAYS_SET = ["archived", "import_incomplete"]
# Only identity survives a truncated row.
TRUNCATED_SAFE = {"name", "interal_product_id"}

TEXT_FIELDS = {
    "name", "description", "category", "part_class", "unit", "warehouse", "location",
    "supplier", "supplier_code", "preferred_supplier", "preferred_supplier_code",
    "inventory_code", "drawing_revision", "source_note", "interal_product_id",
}


def differs(field, new, current) -> bool:
    if new is None:
        return False
    if field in TEXT_FIELDS:
        return (current or "") != new
    if isinstance(new, float):
        return current is None or abs(float(current) - new) > 1e-9
    return current != new


def plan_update(item: dict, current: dict) -> dict:
    """Which columns this row actually moves — quantity is handled separately."""
    allowed = TRUNCATED_SAFE if item["status"] == "truncated" else set(SOURCE_OWNED)
    changes = {
        field: item[field]
        for field in SOURCE_OWNED
        if field in allowed and differs(field, item.get(field), current.get(field))
    }
    for field in ALWAYS_SET:
        if item[field] != current.get(field):
            changes[field] = item[field]
    return changes


# ─── Import ───────────────────────────────────────────────────────────────────

INSERT_COLUMNS = [
    "code", "name", "description", "category", "part_class", "unit", "quantity",
    "quantity_available", "average_cost", "warehouse", "location", "supplier",
    "supplier_code", "supplier_id", "preferred_supplier", "preferred_supplier_code",
    "inventory_code", "stockable", "sale_markup", "drawing_revision", "source_note",
    "interal_product_id", "archived", "import_incomplete",
]
# stock_items.name is NOT NULL and the catalogue stores "" for the 3 641 products
# Interal gives no PRODUCT_NAME for; quantity has to land on a number even when
# the row was too broken to carry one.
INSERT_DEFAULTS = {"name": "", "quantity": 0.0}


async def run(path: str, plant_code: str, apply: bool, report_path: str | None):
    stamp = datetime.now()
    source_name = os.path.basename(path)

    print(f"\n=== Interal inventory import — {source_name} ===")
    print(f"  mode  : {'APPLY' if apply else 'PREVIEW (nothing is written)'}")
    print(f"  db    : {re.sub(r'//[^@]*@', '//***@', PG_URL)}")

    physical = read_sheet(path)
    records, structure = assemble(physical)
    print(f"  sheet : {len(physical)} physical rows → {len(records)} product records")
    print(f"          {structure['spliced']} rebuilt from a split row, "
          f"{structure['truncated']} truncated, {structure['blank_rows']} blank")

    items: list[dict] = []
    duplicates: list[str] = []
    codeless = 0
    seen: set[str] = set()
    for row in records:
        item = build_item(row)
        if item is None:
            codeless += 1
            continue
        if item["code"] in seen:
            duplicates.append(item["code"])
            continue
        seen.add(item["code"])
        items.append(item)

    conn = await asyncpg.connect(PG_URL)
    try:
        plant = await conn.fetchrow("SELECT id FROM plants WHERE code = $1", plant_code)
        if not plant:
            raise SystemExit(f"Plant '{plant_code}' not found — nothing imported.")
        plant_id = plant["id"]

        suppliers = {
            record["code"]: record["id"]
            for record in await conn.fetch(
                "SELECT code, id FROM suppliers WHERE code IS NOT NULL"
            )
        }

        columns = ", ".join(SOURCE_OWNED + ALWAYS_SET)
        existing = {
            record["code"]: dict(record)
            for record in await conn.fetch(
                f"SELECT id, code, quantity, supplier_id, {columns} "
                "FROM stock_items WHERE plant_id = $1",
                plant_id,
            )
        }
        print(f"  plant : {plant_code} — {len(existing)} items already on the platform")

        inserts: list[dict] = []
        updates: list[tuple] = []
        unresolved_suppliers = Counter()
        id_conflicts: list[tuple] = []
        balance_changes = 0

        for item in items:
            code = item.get("supplier_code")
            item["supplier_id"] = suppliers.get(code) if code else None
            if code and not item["supplier_id"]:
                unresolved_suppliers[code] += 1

            current = existing.get(item["code"])
            if current is None:
                inserts.append(item)
                continue

            if (item.get("interal_product_id") and current.get("interal_product_id")
                    and item["interal_product_id"] != current["interal_product_id"]):
                id_conflicts.append(
                    (item["code"], current["interal_product_id"], item["interal_product_id"])
                )

            changes = plan_update(item, current)
            # supplier_id is only ever filled in, never cleared: the link can have
            # been set by hand on the platform and the sheet is not its owner.
            if item["supplier_id"] and item["supplier_id"] != current.get("supplier_id"):
                changes["supplier_id"] = item["supplier_id"]

            quantity = item.get("quantity")
            before = float(current.get("quantity") or 0.0)
            new_quantity = (
                quantity if quantity is not None and abs(quantity - before) > 1e-9 else None
            )
            if new_quantity is not None:
                balance_changes += 1
            if changes or new_quantity is not None:
                updates.append((current["id"], item, changes, new_quantity, before))

        print(f"\n  to create : {len(inserts)}")
        print(f"  to update : {len(updates)}  (of which {balance_changes} change a balance)")
        print(f"  unchanged : {len(items) - len(inserts) - len(updates)}")

        if apply:
            placeholders = ", ".join(f"${i}" for i in range(4, 4 + len(INSERT_COLUMNS)))
            insert_sql = (
                "INSERT INTO stock_items (id, plant_id, source_synced_at, "
                f"{', '.join(INSERT_COLUMNS)}) VALUES ($1, $2, $3, {placeholders})"
            )
            async with conn.transaction():
                for item in inserts:
                    await conn.execute(
                        insert_sql, uuid.uuid4(), plant_id, stamp,
                        *[
                            item.get(column)
                            if item.get(column) is not None
                            else INSERT_DEFAULTS.get(column)
                            for column in INSERT_COLUMNS
                        ],
                    )
                for item_id, item, changes, new_quantity, before in updates:
                    if new_quantity is not None:
                        # Same shape as InventoryService.adjust_stock: the balance
                        # is set, and the delta is what the ledger records. No
                        # `source`, so this never feeds the purchase average.
                        await conn.execute(
                            "INSERT INTO inventory_movements (id, stock_item_id, movement_type, "
                            "quantity, quantity_before, quantity_after, notes, created_at) "
                            "VALUES ($1, $2, 'adjustment', $3, $4, $5, $6, $7)",
                            uuid.uuid4(), item_id, new_quantity - before, before, new_quantity,
                            f"Interal extraction {source_name}"[:500], stamp,
                        )
                        changes["quantity"] = new_quantity
                    changes["source_synced_at"] = stamp
                    fields = list(changes)
                    await conn.execute(
                        "UPDATE stock_items SET "
                        + ", ".join(f"{field} = ${i}" for i, field in enumerate(fields, start=2))
                        + " WHERE id = $1",
                        item_id, *[changes[field] for field in fields],
                    )
            print("\n  applied.")
        else:
            print("\n  preview only — re-run with --apply to write.")
    finally:
        await conn.close()

    written = write_report(
        report_path, source_name, path, stamp, apply, plant_code, physical, structure,
        items, codeless, duplicates, inserts, updates, balance_changes,
        unresolved_suppliers, id_conflicts, existing,
    )
    if written:
        print(f"  report: {written}")


# ─── Report ───────────────────────────────────────────────────────────────────

def write_report(report_path, source_name, source_path, stamp, apply, plant_code,
                 physical, structure, items, codeless, duplicates, inserts, updates,
                 balance_changes, unresolved_suppliers, id_conflicts, existing):
    if not report_path:
        return None
    directory = os.path.dirname(report_path)
    if directory:
        os.makedirs(directory, exist_ok=True)

    truncated = [i for i in items if i["status"] == "truncated"]
    repaired = [i for i in items if i["status"] == "repaired"]
    overrides = [i for i in items
                 if i.get("_use_sale_price_override") or (i.get("_sale_price_override") or 0)]
    batch = [i for i in items if i.get("_batch_tracked")]
    archived = [i for i in items if i["archived"]]
    untouched = len(set(existing) - {i["code"] for i in items})

    lines = [
        f"# Interal inventory import — {source_name}",
        "",
        f"* run      : {stamp:%Y-%m-%d %H:%M:%S} — **{'APPLIED' if apply else 'PREVIEW'}**",
        f"* source   : `{source_path}`",
        f"* plant    : {plant_code}",
        "",
        "## Scope",
        "",
        "| | |",
        "|---|---:|",
        f"| physical rows in the sheet | {len(physical)} |",
        f"| blank rows (inside split records) | {structure['blank_rows']} |",
        f"| product records after repair | {structure['records']} |",
        f"| rebuilt from a split row | {structure['spliced']} |",
        f"| left truncated | {structure['truncated']} |",
        f"| rows with no part number | {codeless} |",
        f"| importable records | {len(items)} |",
        f"| of which retired in the source (`xPA-`) | {len(archived)} |",
        f"| items already on the platform | {len(existing)} |",
        "",
        "## Result",
        "",
        "| | |",
        "|---|---:|",
        f"| created | {len(inserts)} |",
        f"| updated | {len(updates)} |",
        f"| of which a balance changed | {balance_changes} |",
        f"| unchanged | {len(items) - len(inserts) - len(updates)} |",
        f"| on the platform, absent from the sheet (left alone) | {untouched} |",
        "",
    ]

    if repaired:
        lines += [
            "## Records rebuilt from a split row",
            "",
            "A line break inside DESCRIPTION split these across physical rows; the tail was "
            "spliced back and re-validated (unit, stockable flag, price invariant) before use.",
            "",
        ]
        lines += [f"* `{i['code']}` — {i['repair_note']}" for i in repaired] + [""]

    if truncated:
        lines += [
            "## Records left incomplete (`import_incomplete`)",
            "",
            "The row ends at DESCRIPTION and the rest was lost by the export. Only the identity "
            "fields were taken; quantity, cost, location and supplier keep whatever the platform "
            "already holds — a truncated row is not evidence that a count is zero.",
            "",
        ]
        lines += [
            f"* `{i['code']}` (sheet row {i['excel_row']}) — {i['repair_note']}"
            for i in truncated
        ] + [""]

    if duplicates:
        lines += ["## Duplicate part numbers in the sheet (first row wins)", ""]
        lines += [f"* `{code}`" for code in duplicates] + [""]

    if id_conflicts:
        lines += [
            "## ID_PRODUCT changed for a code already on the platform",
            "",
            "| code | on the platform | in the sheet |",
            "|---|---|---|",
        ]
        lines += [f"| `{c}` | {old} | {new} |" for c, old, new in id_conflicts] + [""]

    if unresolved_suppliers:
        lines += [
            "## Supplier codes with no supplier record (text kept, no link made)",
            "",
        ]
        lines += [
            f"* `{code}` — {count} item(s)"
            for code, count in unresolved_suppliers.most_common()
        ] + [""]

    lines += [
        "## Columns not imported",
        "",
        "| column | why |",
        "|---|---|",
        "| `NO_EXPENSE_ACCOUNT_SET` | empty in every row |",
        "| `DESCRIPTION2` | 2 cells, both inside broken rows |",
        "| `NO_PART_CODE` | 8 cells, all shifted values from broken rows |",
        "| `F_STOCKABLE1` | identical to `F_STOCKABLE` in every intact row |",
        "| `UNIT_UTIL` | identical to `UNIT_STORAGE` in every intact row |",
        "| `ID_UNIT_STORAGE`, `ID_UNIT_UTIL` | Interal's internal unit keys |",
        "| `TOTAL_SALE_PRICE` | derived: `AVERAGE_UNIT_PRICE` × `QUOTED_PROFIT` |",
        "| `ID_CUSTOMER` | ambiguous against supplier codes in both directions |",
        "| `F_SERIAL_NUMBER` | 0 in every intact row |",
        "| `F_BATCH_NUMBER` | set on the item(s) listed below only |",
        "| `SALE_PRICE_EDITABLE`, `F_USE_EDITABLE_SALE_PRICE` | the items listed below only |",
        "",
    ]
    if overrides:
        lines += [
            "### Sale-price overrides held in the source (not imported)",
            "",
            "| code | override | in use |",
            "|---|---:|---|",
        ]
        lines += [
            f"| `{i['code']}` | {i.get('_sale_price_override')} | "
            f"{'yes' if i.get('_use_sale_price_override') else 'no'} |"
            for i in overrides
        ] + [""]
    if batch:
        lines += ["### Batch-tracked in the source (not imported)", ""]
        lines += [f"* `{i['code']}`" for i in batch] + [""]

    with open(report_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))

    changes_path = os.path.splitext(report_path)[0] + "_changes.csv"
    with open(changes_path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["code", "action", "field", "from", "to"])
        for item in inserts:
            writer.writerow([item["code"], "create", "quantity", "", item.get("quantity")])
        for _id, item, changes, new_quantity, before in updates:
            current = existing[item["code"]]
            if new_quantity is not None:
                writer.writerow([item["code"], "update", "quantity", before, new_quantity])
            for field, value in changes.items():
                if field in ("quantity", "source_synced_at"):
                    continue
                writer.writerow([item["code"], "update", field, current.get(field), value])
    return report_path


def main():
    parser = argparse.ArgumentParser(
        description="Refresh the stock catalogue from an Interal .xlsx extraction."
    )
    parser.add_argument("--file", required=True, help="Path to the .xlsx extraction")
    parser.add_argument("--plant", default="QS", help="Plant code that owns the catalogue")
    parser.add_argument("--apply", action="store_true",
                        help="Write the changes (default is a preview that writes nothing)")
    parser.add_argument("--report", default=None, help="Path of the markdown report to write")
    args = parser.parse_args()
    if not os.path.exists(args.file):
        raise SystemExit(f"File not found: {args.file}")
    asyncio.run(run(args.file, args.plant, args.apply, args.report))


if __name__ == "__main__":
    main()
