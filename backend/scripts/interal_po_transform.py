"""Interal purchase-order extraction  ->  normalized JSON, with validation.

Reads the raw ERP dump (UTF-8, ';'-separated, ',' decimal) and emits one JSON
record per LOGICAL purchase order. Nothing is written to the database here; the
output is meant to be read and argued with before `interal_po_load.py` applies it.

Two things about the file shape drive this script:

1. A remark containing a line break splits one order across two physical CSV
   lines. The continuation is NOT a short row — the exporter pads it, so it
   arrives with the full 41 fields and a naive field-count check passes it as a
   valid order. It has to be detected by CONTENT (ID_ORDER is not a number) and
   folded back onto the order above it. Its fields 0..7 are the order's fields
   33..40 pushed right by the break, so the fold is a fixed +33 shift, and every
   target field is asserted empty before it is written.

2. The money columns are three different figures, not one repeated. They are
   carried through unchanged and never summed or reconciled:
     COST_SUB_TOTAL            — before whatever the source adds on top
     COST_GRAND_TOTAL          — the order total, in the ORDER's currency
     COST_GRAND_TOTAL_CURRENCY — the same total in the plant's home currency

Usage:
    python interal_po_transform.py <extract.csv> [-o out.json] [--quiet]
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

EXPECTED_HEADER = [
    "ID_ORDER", "NO_ORDER", "DATE_OPEN", "ID_CUSTOMER", "NAME", "NO_CUSTOMER",
    "COST_GRAND_TOTAL", "EMPLOYEE_APPROVAL", "EMPLOYEE_ISSUER",
    "ID_EMPLOYEE_APPROVAL", "ID_EMPLOYEE_ISSUER", "F_APPROUVED", "F_ACTIVE",
    "CONTACT_NAME", "DATE_CREATED", "PHONE1", "CUSTOMER_ORDER_NO",
    "CUSTOMER_NAME", "STATUS", "COST_SUB_TOTAL", "F_RECURENCE",
    "ID_EMPLOYEE_AWAITING_APPROVAL", "NO_DOCK_STATION", "ID_DOCK_STATION",
    "ID_PLANT", "EMPLOYEE_AWAITING_APPROVAL", "EMPLOYEE_BUYER", "F_PRINTED",
    "F_DOCUMENT_SEND", "F_SUPPLIER_RECEIVE_DOC", "F_BIT_STATUS",
    "F_UNLOADING_AUTO", "EMAIL_TO", "INTERNAL_REMARK",
    "COST_GRAND_TOTAL_CURRENCY", "NO_BRANCH", "SHORT_NAME", "SYMBOL", "F_EMAIL",
    "ACCOUNTING_DATE", "UI_STATUS",
]
IDX = {name: i for i, name in enumerate(EXPECTED_HEADER)}

# A continuation's field i is the order's field i + TAIL_OFFSET.
TAIL_OFFSET = IDX["INTERNAL_REMARK"]          # 33
REMARK = IDX["INTERNAL_REMARK"]

PO_NUMBER_RE = re.compile(r"^PO-\d+$")
VALID_STATUS = {"OPEN", "PARTIAL"}


class TransformError(Exception):
    """The file is not shaped the way this script knows how to read."""


# ── primitives ────────────────────────────────────────────────────────────────

def parse_money(raw: str, field: str, po: str):
    """'1318,5' -> 1318.5 . Comma decimal, no thousands separator in this export."""
    s = (raw or "").strip()
    if not s:
        return None
    if "." in s and "," in s:
        raise TransformError(f"{po}: {field}={s!r} has both separators; ambiguous")
    try:
        return float(s.replace(",", "."))
    except ValueError as exc:
        raise TransformError(f"{po}: {field}={s!r} is not a number") from exc


def parse_dt(raw: str, field: str, po: str):
    """'2026-09-15 08:33' / '2026-09-15 00:00' -> ISO string, or None if blank."""
    s = (raw or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).isoformat()
        except ValueError:
            continue
    raise TransformError(f"{po}: {field}={s!r} is not a recognised date")


def parse_bool(raw: str):
    s = (raw or "").strip().lower()
    return True if s == "true" else False if s == "false" else None


def clean(raw: str):
    s = (raw or "").strip()
    return s or None


# ── reconstruction ────────────────────────────────────────────────────────────

def is_continuation(row: list[str]) -> bool:
    """True when this physical line continues the order above it.

    Decided on CONTENT, never on field count: the exporter pads the continuation
    out to the full 41 fields, so counting them classifies it as a real order.
    A genuine order always opens with a numeric ID_ORDER.
    """
    return not row[0].strip().isdigit()


def fold_continuation(order: list[str], cont: list[str], line_no: int) -> None:
    """Fold a continuation line back onto its order, in place.

    The line break landed inside INTERNAL_REMARK, so the continuation carries the
    rest of that remark in field 0 and the order's remaining tail in fields 1..7.
    """
    frag = cont[0].strip()
    # The exporter wraps the fragment in quotes and doubles the closing one, so
    # CSV parsing leaves a stray quote behind. Strip that artifact, not content.
    frag = frag.rstrip('"')
    if frag:
        head = order[REMARK].strip()
        order[REMARK] = f"{head}\n{frag}" if head else frag

    for i in range(1, len(EXPECTED_HEADER) - TAIL_OFFSET):
        value = cont[i].strip() if i < len(cont) else ""
        if not value:
            continue
        target = i + TAIL_OFFSET
        if order[target].strip():
            raise TransformError(
                f"line {line_no}: folding would overwrite "
                f"{EXPECTED_HEADER[target]}={order[target]!r} with {value!r}"
            )
        order[target] = value

    # Anything past the folded tail must be padding, or the +33 shift is wrong.
    for i in range(len(EXPECTED_HEADER) - TAIL_OFFSET, len(cont)):
        if cont[i].strip():
            raise TransformError(
                f"line {line_no}: unexpected content {cont[i]!r} at field {i} "
                f"of a continuation row"
            )


def reconstruct(rows: list[list[str]], first_line: int) -> list[tuple[int, list[str]]]:
    """Merge continuation lines into their orders. Returns (line_no, fields)."""
    out: list[tuple[int, list[str]]] = []
    for offset, row in enumerate(rows):
        line_no = first_line + offset
        if not any(f.strip() for f in row):
            continue                                   # trailing blank line
        if len(row) != len(EXPECTED_HEADER):
            raise TransformError(
                f"line {line_no}: {len(row)} fields, expected {len(EXPECTED_HEADER)}"
            )
        if is_continuation(row):
            if not out:
                raise TransformError(f"line {line_no}: continuation with no order above it")
            fold_continuation(out[-1][1], row, line_no)
            continue
        out.append((line_no, list(row)))
    return out


# ── normalization ─────────────────────────────────────────────────────────────

def to_record(line_no: int, r: list[str]) -> dict:
    g = lambda name: r[IDX[name]]                                    # noqa: E731
    po = g("NO_ORDER").strip()

    if not PO_NUMBER_RE.match(po):
        raise TransformError(f"line {line_no}: NO_ORDER={po!r} is not a PO number")
    status, ui_status = g("STATUS").strip(), g("UI_STATUS").strip()
    if status not in VALID_STATUS:
        raise TransformError(f"{po}: STATUS={status!r} not one of {sorted(VALID_STATUS)}")
    if status != ui_status:
        raise TransformError(f"{po}: STATUS={status!r} != UI_STATUS={ui_status!r}")

    created = parse_dt(g("DATE_CREATED"), "DATE_CREATED", po)
    if not created:
        raise TransformError(f"{po}: DATE_CREATED is empty; order_date has no source")

    return {
        "source_id":      g("ID_ORDER").strip(),        # ID_ORDER — idempotency key
        "order_number":   po,                           # NO_ORDER
        "external_ref":   clean(g("CUSTOMER_ORDER_NO")),
        "supplier_code":  clean(g("NO_CUSTOMER")),      # matches Supplier.code
        "supplier_name":  clean(g("CUSTOMER_NAME")),
        "supplier_source_id": clean(g("ID_CUSTOMER")),  # Interal PK, NOT our uuid
        "plant_name":     clean(g("NAME")),             # the Foliot unit, not a supplier
        "plant_source_id": clean(g("ID_PLANT")),
        "status":         status,
        "sub_total":      parse_money(g("COST_SUB_TOTAL"), "COST_SUB_TOTAL", po),
        "grand_total":    parse_money(g("COST_GRAND_TOTAL"), "COST_GRAND_TOTAL", po),
        "grand_total_home_currency":
                          parse_money(g("COST_GRAND_TOTAL_CURRENCY"),
                                      "COST_GRAND_TOTAL_CURRENCY", po),
        "currency_symbol": clean(g("SYMBOL")),          # '$' — does NOT name a currency
        "created_at":     created,                      # DATE_CREATED
        "accounting_date": parse_dt(g("ACCOUNTING_DATE"), "ACCOUNTING_DATE", po),
        "date_open":      parse_dt(g("DATE_OPEN"), "DATE_OPEN", po),   # empty in this file
        "approved":       parse_bool(g("F_APPROUVED")),
        "active":         parse_bool(g("F_ACTIVE")),
        "employee_approval": clean(g("EMPLOYEE_APPROVAL")),
        "employee_issuer":   clean(g("EMPLOYEE_ISSUER")),
        "employee_buyer":    clean(g("EMPLOYEE_BUYER")),
        "contact_name":   clean(g("CONTACT_NAME")),
        "contact_phone":  clean(g("PHONE1")),
        "contact_email":  clean(g("EMAIL_TO")),
        "internal_remark": clean(g("INTERNAL_REMARK")),
        "source_line":    line_no,
    }


# ── audit ─────────────────────────────────────────────────────────────────────

def column_audit(orders: list[list[str]]) -> dict:
    empty, partial, full = [], {}, []
    for i, name in enumerate(EXPECTED_HEADER):
        filled = sum(1 for o in orders if o[i].strip())
        if filled == 0:
            empty.append(name)
        elif filled < len(orders):
            partial[name] = f"{filled}/{len(orders)}"
        else:
            full.append(name)
    return {"empty": empty, "partially_filled": partial, "always_filled": full}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv_path", type=Path)
    ap.add_argument("-o", "--out", type=Path, help="write normalized JSON here")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    raw = args.csv_path.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise TransformError(
            f"{args.csv_path} is not valid UTF-8 ({exc}). Re-export it as UTF-8 "
            f"rather than guessing an encoding — a wrong guess silently mangles "
            f"accented supplier names."
        ) from exc

    rows = list(csv.reader(io.StringIO(text), delimiter=";"))
    if not rows:
        raise TransformError("file is empty")
    header = [h.strip() for h in rows[0]]
    if header != EXPECTED_HEADER:
        missing = set(EXPECTED_HEADER) - set(header)
        extra   = set(header) - set(EXPECTED_HEADER)
        raise TransformError(
            f"unexpected header ({len(header)} columns). "
            f"missing={sorted(missing)} unexpected={sorted(extra)}"
        )

    physical = len([r for r in rows[1:] if any(f.strip() for f in r)])
    merged   = reconstruct(rows[1:], first_line=2)
    records  = [to_record(line_no, fields) for line_no, fields in merged]

    dupes = [n for n, c in Counter(r["order_number"] for r in records).items() if c > 1]
    if dupes:
        raise TransformError(f"duplicate order numbers in the extraction: {dupes}")
    dupe_ids = [n for n, c in Counter(r["source_id"] for r in records).items() if c > 1]
    if dupe_ids:
        raise TransformError(f"duplicate ID_ORDER in the extraction: {dupe_ids}")

    audit = column_audit([fields for _, fields in merged])
    report = {
        "source_file":        str(args.csv_path),
        "source_sha_bytes":   len(raw),
        "physical_data_lines": physical,
        "orders":             len(records),
        "reconstructed":      physical - len(records),
        "status_counts":      dict(Counter(r["status"] for r in records)),
        "suppliers":          len({r["supplier_code"] for r in records}),
        "plants":             sorted({r["plant_name"] for r in records}),
        "date_range":         [min(r["created_at"] for r in records),
                               max(r["created_at"] for r in records)],
        "orders_with_remark": sum(1 for r in records if r["internal_remark"]),
        "column_audit":       audit,
        # Stated plainly so nobody reads this import as a full purchase history.
        "not_in_extraction": [
            "line items (part codes, quantities, unit prices)",
            "received quantities / receipt dates",
            "expected delivery dates",
            "closed / completed orders (only OPEN and PARTIAL are present)",
        ],
    }

    if not args.quiet:
        out = sys.stdout
        print(f"orders            : {report['orders']} "
              f"(from {physical} physical lines, {report['reconstructed']} folded)", file=out)
        print(f"status            : {report['status_counts']}", file=out)
        print(f"suppliers         : {report['suppliers']}", file=out)
        print(f"plants            : {report['plants']}", file=out)
        print(f"created between   : {report['date_range'][0]} .. {report['date_range'][1]}", file=out)
        print(f"empty columns ({len(audit['empty'])}) : {audit['empty']}", file=out)
        print(f"partial columns   : {audit['partially_filled']}", file=out)
        print("", file=out)
        for r in records:
            money = f"sub={r['sub_total']} grand={r['grand_total']} home={r['grand_total_home_currency']}"
            print(f"  {r['order_number']}  id={r['source_id']:<5} {r['status']:<8} "
                  f"{(r['supplier_name'] or ''):<20} {money}", file=out)
            if r["internal_remark"] and "\n" in r["internal_remark"]:
                print(f"      remark spans {r['internal_remark'].count(chr(10)) + 1} lines", file=out)

    if args.out:
        args.out.write_text(
            json.dumps({"report": report, "orders": records}, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        if not args.quiet:
            print(f"\nwrote {args.out}", file=sys.stdout)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except TransformError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(2)
