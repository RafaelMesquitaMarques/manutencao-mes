#!/usr/bin/env python3
"""
scripts/interal_po_load.py
Replace the demo purchase orders with the real ones from the Interal extraction.

Reads the JSON produced by ``interal_po_transform.py`` and applies it. It is
deliberately a two-step import: the transform can be read and argued with before
anything touches the database.

What it does
------------
* Resolves every supplier by CODE (Interal NO_CUSTOMER == Supplier.code), exact
  match only. A code that matches zero or more than one supplier ABORTS the whole
  run — no supplier is created, renamed, merged or guessed at by name.
* Resolves the buying plant by name, once, the same way.
* Upserts orders keyed on (import_source, import_ref). Re-running updates the
  rows it already wrote; it never mints a second copy.
* Deletes the demo purchase orders — the ones with no import provenance — and
  the data that exists only because they did: their lines, their attachments
  (rows and files) and the stock movement a demo receipt wrote.

What it deliberately does NOT do
--------------------------------
* No line items are invented. The extraction has none: no part codes, no
  quantities, no unit prices. The header total is the only money there is, and
  it is stored as given rather than recomputed from lines that do not exist.
* No receipts, no stock movements, no e-mail, no approval requests, no payment.
  These orders are a snapshot of what the source system already holds; replaying
  them as platform operations would invent history.
* Suppliers, parts, equipment, users and every other shared record are read-only
  here. The single exception is documented under --purge: a demo RECEIPT wrote
  last_purchase_cost/date onto a real part, and undoing that fake receipt is the
  point of the purge.

Usage (inside the backend container, from /app):
    python scripts/interal_po_load.py --json po.json --dry-run
    python scripts/interal_po_load.py --json po.json --apply --purge
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import delete, func, select                      # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402
from sqlalchemy.orm import selectinload                          # noqa: E402
from sqlalchemy.pool import NullPool                             # noqa: E402

from app.core.config import settings                             # noqa: E402
from app.models.models import (                                  # noqa: E402
    InventoryMovement, Plant, PurchaseOrder, PurchaseOrderAttachment,
    PurchaseOrderItem, PurchaseOrderStatus, StockItem, Supplier,
)

IMPORT_SOURCE = "interal"

# Interal's order lifecycle, mapped onto the platform's.
#
#   OPEN    -> sent       issued to the supplier, nothing received yet
#   PARTIAL -> confirmed  issued, acknowledged, some of it already delivered
#
# `confirmed` is a SUPERSET of what PARTIAL says, not a synonym: the platform has
# no partially-received status, so the "some of it arrived" half of PARTIAL has
# no column to live in. It is NOT reconstructed from quantities — the extraction
# carries none — so the source word is kept verbatim in legacy_meta.source_status
# and shown on the order, and that string stays the authority on what the ERP said.
STATUS_MAP = {
    "OPEN":    PurchaseOrderStatus.sent,
    "PARTIAL": PurchaseOrderStatus.confirmed,
}


class LoadError(Exception):
    """Something the loader will not decide on its own."""


def _log(msg: str = "") -> None:
    print(msg, flush=True)


# ── resolution ────────────────────────────────────────────────────────────────

async def resolve_suppliers(db, records) -> dict:
    """code -> Supplier. Exact match on code; ambiguity or absence aborts."""
    codes = sorted({r["supplier_code"] for r in records if r["supplier_code"]})
    missing_code = [r["order_number"] for r in records if not r["supplier_code"]]
    if missing_code:
        raise LoadError(f"orders with no NO_CUSTOMER, cannot match a supplier: {missing_code}")

    rows = (await db.execute(
        select(Supplier).where(Supplier.code.in_(codes))
    )).scalars().all()

    by_code: dict[str, list[Supplier]] = {}
    for s in rows:
        by_code.setdefault(s.code, []).append(s)

    resolved, problems = {}, []
    for code in codes:
        hits = by_code.get(code, [])
        if len(hits) == 1:
            resolved[code] = hits[0]
        elif not hits:
            names = sorted({r["supplier_name"] for r in records if r["supplier_code"] == code})
            problems.append(f"  code {code} ({', '.join(names)}): no supplier with this code")
        else:
            problems.append(
                f"  code {code}: {len(hits)} suppliers share it "
                f"({', '.join(str(h.id) for h in hits)}) — ambiguous, refusing to guess"
            )
    if problems:
        raise LoadError(
            "supplier matching failed; nothing was written:\n" + "\n".join(problems) +
            "\n\nFix the supplier records (or the extraction) and re-run. This script "
            "never creates or renames a supplier."
        )
    return resolved


async def resolve_plant(db, records) -> Plant:
    names = sorted({r["plant_name"] for r in records if r["plant_name"]})
    if len(names) != 1:
        raise LoadError(f"expected exactly one buying plant in the extraction, got {names}")
    name = names[0]
    hits = (await db.execute(select(Plant).where(Plant.name == name))).scalars().all()
    if len(hits) != 1:
        raise LoadError(
            f"plant {name!r} matches {len(hits)} rows in `plants`; refusing to guess. "
            f"(The extraction's ID_PLANT is Interal's id, not this platform's.)"
        )
    return hits[0]


# ── purge ─────────────────────────────────────────────────────────────────────

async def purge_demo_orders(db, *, apply: bool) -> dict:
    """Remove the purchase orders that have no import provenance, and only the
    data that exists solely because of them."""
    demo = (await db.execute(
        select(PurchaseOrder)
        .where(PurchaseOrder.import_source.is_(None))
        .options(selectinload(PurchaseOrder.items), selectinload(PurchaseOrder.attachments),
                 selectinload(PurchaseOrder.supplier))
    )).scalars().all()

    summary = {"orders": [], "items": 0, "attachments": [], "movements": [], "parts_reset": []}
    if not demo:
        return summary

    for po in demo:
        summary["orders"].append({
            "order_number": po.order_number,
            "supplier": po.supplier.name if po.supplier else None,
            "status": po.status.value if hasattr(po.status, "value") else po.status,
            "total": po.total_amount,
            "items": len(po.items or []),
        })
        summary["items"] += len(po.items or [])
        for a in (po.attachments or []):
            summary["attachments"].append({"id": str(a.id), "name": a.original_name,
                                           "stored": a.stored_name})

    numbers = [po.order_number for po in demo]

    # A demo receipt books a real stock movement stamped source='purchase', and
    # that marking is the ONLY input to a part's weighted average cost. Left
    # behind it would keep money that was never spent in the average of a real
    # Interal part, and its note would point at an order that no longer exists.
    movements = (await db.execute(
        select(InventoryMovement).where(
            InventoryMovement.source == "purchase",
            func.coalesce(InventoryMovement.notes, "").in_(
                [f"Purchase Order {n}" for n in numbers]
            ),
        )
    )).scalars().all()

    for mv in movements:
        stock = await db.get(StockItem, mv.stock_item_id)
        summary["movements"].append({
            "id": str(mv.id), "note": mv.notes, "qty": mv.quantity,
            "unit_cost": mv.unit_cost,
            "part": stock.code if stock else None,
        })
        # Undo only what THIS fake receipt wrote, and only when it is still the
        # value on the row. `quantity` is deliberately NOT rolled back: the real
        # Interal stock extraction has since restated it, and reversing a demo
        # +2 on top of a real count would corrupt the real one.
        if stock and mv.unit_cost is not None and stock.last_purchase_cost == mv.unit_cost:
            summary["parts_reset"].append({
                "part": stock.code,
                "cleared": {"last_purchase_cost": stock.last_purchase_cost,
                            "last_purchase_date": str(stock.last_purchase_date)},
                "quantity_left_as_is": stock.quantity,
                "average_cost_left_as_is": stock.average_cost,
            })
            if apply:
                stock.last_purchase_cost = None
                stock.last_purchase_date = None

    if apply:
        for mv in movements:
            await db.delete(mv)
        for po in demo:
            # items + attachment ROWS cascade via the relationship; the files on
            # disk are removed by the caller, which knows UPLOAD_DIR.
            await db.delete(po)
        await db.flush()

    return summary


def delete_attachment_files(attachments: list[dict], *, apply: bool) -> list[str]:
    """Remove the orphaned files a purged attachment leaves in the uploads volume."""
    from app.api.routes.suppliers import _attachment_path
    removed = []
    for a in attachments:
        path = Path(_attachment_path(a["stored"]))
        if path.exists():
            removed.append(str(path))
            if apply:
                try:
                    path.unlink()
                except OSError as exc:                       # pragma: no cover
                    _log(f"  ! could not delete {path}: {exc}")
    return removed


# ── upsert ────────────────────────────────────────────────────────────────────

def build_legacy_meta(r: dict) -> dict:
    """Everything the extraction carries that has no column of its own.

    Money note: grand_total_home_currency is the SAME total restated in the
    plant's home currency, not a second charge. On this extraction the two agree
    everywhere except the one supplier whose currency is not CAD. They are never
    added together, and no exchange rate is stored — only the two given figures.
    """
    return {
        "source":            IMPORT_SOURCE,
        "source_id":         r["source_id"],
        "source_status":     r["status"],          # 'OPEN' / 'PARTIAL', verbatim
        "approved":          r["approved"],        # F_APPROUVED — NOT the status
        "employee_approval": r["employee_approval"],
        "employee_issuer":   r["employee_issuer"],
        "employee_buyer":    r["employee_buyer"],
        "accounting_date":   r["accounting_date"], # NOT a due or delivery date
        "created_at_source": r["created_at"],
        "sub_total":         r["sub_total"],
        "grand_total":       r["grand_total"],
        "grand_total_home_currency": r["grand_total_home_currency"],
        "currency_symbol":   r["currency_symbol"], # '$' alone names no currency
        "contact_phone":     r["contact_phone"],
        "contact_email":     r["contact_email"],   # stored, never mailed
        "supplier_source_id": r["supplier_source_id"],
        "supplier_name_at_source": r["supplier_name"],
        "plant_name_at_source":    r["plant_name"],
        "plant_source_id":   r["plant_source_id"],
        "imported_at":       datetime.now().astimezone().isoformat(timespec="seconds"),
    }


async def upsert_orders(db, records, suppliers, plant, *, apply: bool) -> dict:
    existing = {
        po.import_ref: po
        for po in (await db.execute(
            select(PurchaseOrder).where(PurchaseOrder.import_source == IMPORT_SOURCE)
        )).scalars().all()
    }
    # An order number already used by a DIFFERENT row would break the unique
    # constraint halfway through; find that out before writing anything.
    numbers = [r["order_number"] for r in records]
    clashes = (await db.execute(
        select(PurchaseOrder).where(
            PurchaseOrder.order_number.in_(numbers),
            PurchaseOrder.import_source.is_distinct_from(IMPORT_SOURCE),
        )
    )).scalars().all()
    if clashes:
        raise LoadError(
            "these order numbers already exist on non-imported orders: "
            + ", ".join(sorted(c.order_number for c in clashes))
        )

    created, updated = [], []
    for r in records:
        supplier = suppliers[r["supplier_code"]]
        created_at = datetime.fromisoformat(r["created_at"])
        fields = dict(
            order_number=r["order_number"],
            supplier_id=supplier.id,
            plant_id=plant.id,
            status=STATUS_MAP[r["status"]],
            # DATE_CREATED is when the order was raised. ACCOUNTING_DATE is a
            # different fact and is kept in legacy_meta — using it here would
            # silently restate when these orders were placed.
            order_date=created_at.date(),
            expected_date=None,   # not in the extraction; not invented
            received_date=None,   # not in the extraction; not invented
            total_amount=r["grand_total"],
            subtotal_amount=r["sub_total"],
            # The supplier record is what names the currency. The extraction's
            # SYMBOL is '$' on every row, which distinguishes nothing — and the
            # one order whose two totals disagree is the one whose supplier is
            # not on CAD.
            currency=supplier.currency or "CAD",
            external_ref=r["external_ref"],
            notes=r["internal_remark"],
            import_source=IMPORT_SOURCE,
            import_ref=r["source_id"],
            legacy_meta=build_legacy_meta(r),
            # Karine Henry is the buyer/issuer/approver on every row, but no user
            # in this platform carries that name and the Interal employee id is
            # not ours. Linking on a name alone would be a guess, so the names
            # stay as text in legacy_meta and the order has no created_by.
            created_by_id=None,
        )

        po = existing.get(r["source_id"])
        if po is None:
            created.append(r["order_number"])
            if apply:
                po = PurchaseOrder(**fields)
                # Historical creation time, so the order does not claim to have
                # been raised on the day it was imported.
                po.created_at = created_at.astimezone()
                db.add(po)
        else:
            updated.append(r["order_number"])
            if apply:
                for k, v in fields.items():
                    setattr(po, k, v)
    if apply:
        await db.flush()
    return {"created": created, "updated": updated}


# ── main ──────────────────────────────────────────────────────────────────────

async def run(args) -> int:
    payload = json.loads(Path(args.json).read_text(encoding="utf-8"))
    records = payload["orders"]
    report  = payload.get("report", {})

    engine = create_async_engine(settings.DATABASE_URL, poolclass=NullPool)
    maker  = async_sessionmaker(engine, expire_on_commit=False)

    mode = "APPLY" if args.apply else "DRY-RUN"
    _log(f"=== Interal purchase-order import [{mode}] ===")
    _log(f"source     : {report.get('source_file')}")
    _log(f"orders     : {len(records)}  status={report.get('status_counts')}")
    _log("")

    async with maker() as db:
        plant     = await resolve_plant(db, records)
        suppliers = await resolve_suppliers(db, records)
        _log(f"plant      : {plant.name} ({plant.code})  id={plant.id}")
        _log(f"suppliers  : {len(suppliers)}/{len({r['supplier_code'] for r in records})} matched by code")
        for code, s in sorted(suppliers.items()):
            n = sum(1 for r in records if r["supplier_code"] == code)
            _log(f"    {code}  {s.name:<22} {s.currency or 'CAD':<4} {n} order(s)")
        _log("")

        purged = {"orders": [], "items": 0, "attachments": [], "movements": [], "parts_reset": []}
        if args.purge:
            purged = await purge_demo_orders(db, apply=args.apply)
            _log(f"purge      : {len(purged['orders'])} demo order(s), "
                 f"{purged['items']} line(s), {len(purged['attachments'])} attachment(s), "
                 f"{len(purged['movements'])} stock movement(s)")
            for o in purged["orders"]:
                _log(f"    - {o['order_number']:<14} {o['status']:<9} "
                     f"{(o['supplier'] or ''):<44} total={o['total']} items={o['items']}")
            for m in purged["movements"]:
                _log(f"    - movement {m['note']} ({m['qty']} x {m['unit_cost']} on {m['part']})")
            for p in purged["parts_reset"]:
                _log(f"    - {p['part']}: cleared {p['cleared']}; "
                     f"quantity stays {p['quantity_left_as_is']}, "
                     f"average_cost stays {p['average_cost_left_as_is']}")
            files = delete_attachment_files(purged["attachments"], apply=args.apply)
            for f in files:
                _log(f"    - file {f}")
            _log("")

        result = await upsert_orders(db, records, suppliers, plant, apply=args.apply)
        _log(f"import     : {len(result['created'])} created, {len(result['updated'])} updated")
        for n in result["created"]:
            _log(f"    + {n}")
        for n in result["updated"]:
            _log(f"    ~ {n}")

        if args.apply:
            await db.commit()
            _log("\nCOMMITTED.")
        else:
            await db.rollback()
            _log("\nDRY-RUN — rolled back, nothing was written.")

    await engine.dispose()
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--json", required=True, help="output of interal_po_transform.py")
    ap.add_argument("--purge", action="store_true",
                    help="also delete purchase orders that have no import provenance")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true")
    g.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    return asyncio.run(run(args))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except LoadError as exc:
        print(f"\nERROR: {exc}", file=sys.stderr)
        sys.exit(2)
