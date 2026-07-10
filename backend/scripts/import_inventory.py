#!/usr/bin/env python3
"""
scripts/import_inventory.py
Import Inventory.xml + Suppliers.xml into the MES database.

Usage (inside container):
    docker exec mes_backend python /app/scripts/import_inventory.py \
        --inventory /app/data/Inventory.xml \
        --suppliers /app/data/Suppliers.xml

Or locally (needs DATABASE_URL env var pointing to the DB):
    python scripts/import_inventory.py --inventory Inventory.xml --suppliers Suppliers.xml
"""

import argparse
import asyncio
import os
import uuid
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime

import asyncpg

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://mesadmin:mespassword@localhost:5432/manutencao",
)

# For asyncpg we need plain postgresql:// (no +asyncpg)
PG_URL = DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://").replace(
    "postgresql+asyncio://", "postgresql://"
)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def text(el, tag, default=""):
    val = el.findtext(tag)
    return val.strip() if val and val.strip() else default


def floatval(el, tag, default=0.0):
    v = el.findtext(tag)
    try:
        return float(v) if v else default
    except (ValueError, TypeError):
        return default


# ─── Parse Suppliers ─────────────────────────────────────────────────────────

def parse_suppliers(xml_path: str) -> list[dict]:
    tree = ET.parse(xml_path)
    root = tree.getroot()
    suppliers = []
    for t in root.findall("Table"):
        active = text(t, "F_ACTIVE", "0") == "1"
        is_supplier = text(t, "F_SUPPLIER", "0") == "1"
        if not is_supplier:
            continue
        suppliers.append(
            {
                "id": str(uuid.uuid4()),
                "code": text(t, "NO_CUSTOMER"),
                "name": text(t, "NAME") or text(t, "CUSTOMER_NAME", "Unknown"),
                "phone": text(t, "PHONE1") or None,
                "email": text(t, "EMAIL") or None,
                "fax": text(t, "FAX") or None,
                "website": text(t, "WEB") or None,
                "currency": text(t, "NO_CURRENCY", "CAD"),
                "notes": text(t, "SPECIAL_INSTRUCTION") or None,
                "is_active": active,
            }
        )
    print(f"  Parsed {len(suppliers)} suppliers")
    return suppliers


# ─── Parse Inventory ─────────────────────────────────────────────────────────

def parse_inventory(xml_path: str) -> list[dict]:
    tree = ET.parse(xml_path)
    root = tree.getroot()

    # Group by NO_PRODUCT — sum quantities, keep first non-empty metadata
    products: dict[str, dict] = defaultdict(
        lambda: {
            "qty": 0.0,
            "description": "",
            "category": "",
            "part_class": "",
            "unit": "Unitaire",
            "warehouse": "",
            "location": "",
            "interal_id": "",
        }
    )

    for t in root.findall("Table"):
        code = text(t, "NO_PRODUCT")
        if not code or not code.startswith("PA-"):
            continue  # skip malformed rows

        p = products[code]
        qty = floatval(t, "QUANTITY")
        p["qty"] += qty

        desc = text(t, "DESCRIPTION")
        if desc and not p["description"]:
            p["description"] = desc

        cat = text(t, "NO_PART_CATEGORY")
        if cat and not p["category"]:
            p["category"] = cat

        cls = text(t, "NO_PART_CLASS")
        if cls and not p["part_class"]:
            p["part_class"] = cls

        unit = text(t, "UNIT_UTIL", "Unitaire")
        if unit and unit != "Unitaire":
            p["unit"] = unit

        # Primary location = first real warehouse/location we see
        wh = text(t, "NO_WAREHOUSE")
        loc = text(t, "NO_LOCATION")
        if wh and wh != "N/A" and not p["warehouse"]:
            p["warehouse"] = wh
        if loc and loc != "N/A" and not p["location"]:
            p["location"] = loc

        interal_id = text(t, "ID_PRODUCT")
        if interal_id and not p["interal_id"]:
            p["interal_id"] = interal_id

    items = []
    for code, p in products.items():
        items.append(
            {
                "id": str(uuid.uuid4()),
                "plant_id": None,  # Will be set to PLT1 if available
                "code": code,
                "name": "",  # No short name in XML; left blank
                "description": p["description"],
                "category": p["category"] or None,
                "part_class": p["part_class"] or None,
                "unit": p["unit"],
                "quantity": round(p["qty"], 4),
                "min_quantity": None,  # Set manually later
                "unit_cost": None,
                "warehouse": p["warehouse"] or None,
                "location": p["location"] or None,
                "supplier_id": None,
                "supplier": None,
                "interal_product_id": p["interal_id"] or None,
                "notes": None,
            }
        )

    print(f"  Parsed {len(items)} unique stock items (PA-XXXXXXX codes)")
    return items


# ─── DB operations ───────────────────────────────────────────────────────────

async def get_plant_id(conn) -> str | None:
    row = await conn.fetchrow("SELECT id FROM plants WHERE code IN ('QS', 'PLT1') LIMIT 1")
    return str(row["id"]) if row else None


async def import_suppliers(conn, suppliers: list[dict]):
    print("  Importing suppliers...")
    inserted = 0
    skipped = 0
    for s in suppliers:
        existing = await conn.fetchrow(
            "SELECT id FROM suppliers WHERE code = $1", s["code"]
        )
        if existing:
            skipped += 1
            continue
        await conn.execute(
            """
            INSERT INTO suppliers (id, code, name, phone, email, fax, website, currency, notes, is_active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            """,
            s["id"], s["code"], s["name"], s["phone"], s["email"],
            s["fax"], s["website"], s["currency"], s["notes"], s["is_active"],
        )
        inserted += 1
    print(f"  Suppliers: {inserted} inserted, {skipped} already existed")


async def import_items(conn, items: list[dict], plant_id: str | None):
    print("  Importing stock items...")
    inserted = 0
    updated = 0

    for item in items:
        if plant_id:
            item["plant_id"] = plant_id

        existing = await conn.fetchrow(
            "SELECT id FROM stock_items WHERE code = $1", item["code"]
        )
        if existing:
            # Update quantity and metadata but don't overwrite manual min_quantity
            await conn.execute(
                """
                UPDATE stock_items SET
                    description = $2,
                    category = $3,
                    part_class = $4,
                    unit = $5,
                    quantity = $6,
                    warehouse = COALESCE(warehouse, $7),
                    location = COALESCE(location, $8),
                    interal_product_id = $9
                WHERE code = $1
                """,
                item["code"], item["description"], item["category"],
                item["part_class"], item["unit"], item["quantity"],
                item["warehouse"], item["location"], item["interal_product_id"],
            )
            updated += 1
        else:
            await conn.execute(
                """
                INSERT INTO stock_items (
                    id, plant_id, code, name, description, category, part_class,
                    unit, quantity, min_quantity, unit_cost,
                    warehouse, location, supplier_id, supplier,
                    interal_product_id, notes
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,
                    $8,$9,$10,$11,
                    $12,$13,$14,$15,
                    $16,$17
                )
                """,
                item["id"], item["plant_id"], item["code"], item["name"],
                item["description"], item["category"], item["part_class"],
                item["unit"], item["quantity"], item["min_quantity"], item["unit_cost"],
                item["warehouse"], item["location"], item["supplier_id"], item["supplier"],
                item["interal_product_id"], item["notes"],
            )
            inserted += 1

    print(f"  Stock items: {inserted} inserted, {updated} updated")


async def ensure_tables(conn):
    """Create tables if they don't exist yet (idempotent)."""
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS suppliers (
            id UUID PRIMARY KEY,
            code VARCHAR(50),
            name VARCHAR(300) NOT NULL,
            phone VARCHAR(100),
            email VARCHAR(200),
            fax VARCHAR(100),
            website VARCHAR(300),
            currency VARCHAR(10) DEFAULT 'CAD',
            notes TEXT,
            is_active BOOLEAN DEFAULT TRUE
        )
        """
    )

    # Add new columns to stock_items if they don't exist
    cols_to_add = [
        ("category", "VARCHAR(200)"),
        ("part_class", "VARCHAR(200)"),
        ("warehouse", "VARCHAR(100)"),
        ("location", "VARCHAR(100)"),
        ("supplier_id", "UUID REFERENCES suppliers(id) ON DELETE SET NULL"),
        ("interal_product_id", "VARCHAR(50)"),
        ("notes", "TEXT"),
        ("description", "TEXT"),
    ]
    for col, col_type in cols_to_add:
        try:
            await conn.execute(
                f"ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS {col} {col_type}"
            )
        except Exception as e:
            print(f"  Warning adding column {col}: {e}")

    print("  Tables/columns ready.")


# ─── Main ─────────────────────────────────────────────────────────────────────

async def main(inventory_path: str, suppliers_path: str):
    print(f"\n=== Foliot MES — Inventory Import ===")
    print(f"  DB  : {PG_URL}")
    print(f"  Inv : {inventory_path}")
    print(f"  Sup : {suppliers_path}")
    print()

    conn = await asyncpg.connect(PG_URL)
    try:
        await ensure_tables(conn)

        plant_id = await get_plant_id(conn)
        if plant_id:
            print(f"  Plant PLT1 found: {plant_id}")
        else:
            print("  Warning: plant PLT1 not found — items imported without plant_id")

        suppliers = parse_suppliers(suppliers_path)
        await import_suppliers(conn, suppliers)

        items = parse_inventory(inventory_path)
        await import_items(conn, items, plant_id)

    finally:
        await conn.close()

    print("\n  Import complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Import Interal inventory into MES")
    parser.add_argument("--inventory", required=True, help="Path to Inventory.xml")
    parser.add_argument("--suppliers", required=True, help="Path to Suppliers.xml")
    args = parser.parse_args()
    asyncio.run(main(args.inventory, args.suppliers))
