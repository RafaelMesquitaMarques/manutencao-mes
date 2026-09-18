#!/usr/bin/env python3
"""
scripts/interal_wo_load.py
Load the Interal work-order history produced by interal_wo_transform.py.

Runs straight against Postgres with asyncpg, never through the REST API. Every
side effect the platform attaches to a work order -- notifications, inventory
deduction, PM occurrence regeneration, ticket linkage, machine-status repaint --
lives in route/service code, not in database triggers, so a direct INSERT fires
none of them. That is the point: this is history, not new work.

    # preview -- writes the report, touches nothing
    docker run --rm --network manutencao-mes_default -v "<folder>:/data" \
        -e DATABASE_URL="$(docker exec mes_backend printenv DATABASE_URL)" \
        manutencao-mes-backend python /app/scripts/interal_wo_load.py \
        --records /data/build/work_orders.jsonl --report /data/load_report.md

    # apply -- same command plus --apply --replace
    #   ... --apply --replace --report /data/load_report.md

Flags
─────
  --apply     the only thing that writes. Without it nothing is committed.
  --replace   purge the current work-order base (and only work orders + their
              own child rows) before loading. Without it the load is a pure
              upsert on (import_source, import_ref).

Rules the load obeys
────────────────────
* Idempotent on (import_source, import_ref) = the Interal ID_WORK_ORDER_HEADER.
  Re-running never duplicates an order or a text block.
* Shared master data is never deleted. Tables that merely point AT a work order
  (tickets, predictive alerts, supplier orders, machine history, PM occurrences)
  are detached by nulling the reference, so no link is left dangling.
* Equipment present in the history but absent from the catalogue is created
  INACTIVE, with its real Interal code and description, tagged with import_source.
  Nothing is matched by name similarity.
* Employees are linked only on an exact employee number or an exact name (accents
  and case folded). Everyone else keeps their historical name on the order and
  gets no account -- the import never creates a user or sends an invite.
* opened_at / completed_at are written as the naive dates the export carries.
  No date is invented and no timezone shift is applied.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import unicodedata
import uuid
from collections import Counter
from datetime import datetime
from pathlib import Path

import asyncpg

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://mesadmin:mespassword@db:5432/manutencao",
)
PG_URL = re.sub(r"^postgresql\+\w+://", "postgresql://", DATABASE_URL)

IMPORT_SOURCE = "interal_bonsdetravail"

# Columns this import needs that the base schema does not have. Added the same
# way main.py:_run_migrations does it -- gated on information_schema so a
# no-op ALTER is never issued against a live table.
SCHEMA_ADDITIONS = [
    ("work_orders", "import_source", "VARCHAR(40)"),
    ("work_orders", "import_ref", "VARCHAR(40)"),
    ("work_orders", "legacy_technician", "VARCHAR(200)"),
    ("work_orders", "legacy_location", "VARCHAR(200)"),
    ("work_orders", "legacy_meta", "JSONB"),
    ("equipment", "import_source", "VARCHAR(40)"),
    ("equipment", "import_ref", "VARCHAR(40)"),
]
SCHEMA_INDEXES = [
    ("uq_work_orders_import_ref",
     "CREATE UNIQUE INDEX uq_work_orders_import_ref ON work_orders (import_source, import_ref) "
     "WHERE import_source IS NOT NULL"),
    ("uq_equipment_import_ref",
     "CREATE UNIQUE INDEX uq_equipment_import_ref ON equipment (import_source, import_ref) "
     "WHERE import_source IS NOT NULL"),
    # the list page orders by opened_at DESC and pages through it; id is the
    # tiebreaker that keeps that ordering stable across pages.
    ("idx_wo_opened_id", "CREATE INDEX idx_wo_opened_id ON work_orders (opened_at DESC, id)"),
    ("idx_wo_plant_status", "CREATE INDEX idx_wo_plant_status ON work_orders (plant_id, status)"),
]


def norm_name(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().lower()


def parse_dt(s):
    """Interal dates are date-only -- every one of the 65 843 records carries a
    midnight-exact value, no times. They go into `timestamptz` columns, so
    storing them at 00:00 UTC would render as the PREVIOUS day for any viewer
    west of Greenwich (Montreal is UTC-4: 2026-09-09T00:00Z shows as Sep 8).
    Anchoring at 12:00 UTC keeps the calendar date identical from UTC-11 to
    UTC+12 without touching how live work orders render their real timestamps."""
    if not s:
        return None
    dt = datetime.fromisoformat(s)
    if dt.hour == 0 and dt.minute == 0 and dt.second == 0:
        dt = dt.replace(hour=12)
    return dt


async def ensure_schema(conn, apply_changes, log):
    for table, column, ddl_type in SCHEMA_ADDITIONS:
        exists = await conn.fetchval(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = $1 AND column_name = $2",
            table, column,
        )
        if exists:
            continue
        log.append("add column %s.%s %s" % (table, column, ddl_type))
        if apply_changes:
            await conn.execute(
                "ALTER TABLE %s ADD COLUMN %s %s" % (table, column, ddl_type)
            )
    for name, ddl in SCHEMA_INDEXES:
        exists = await conn.fetchval(
            "SELECT 1 FROM pg_indexes WHERE indexname = $1", name
        )
        if exists:
            continue
        log.append("create index %s" % name)
        if apply_changes:
            await conn.execute(ddl)


async def purge_work_orders(conn, apply_changes, log):
    """Delete every work order and the rows that belong to it.

    Shared master data is detached, never deleted: tables that merely point at a
    work order have the reference nulled so nothing is left dangling.
    """
    victims = await conn.fetchval("SELECT count(*) FROM work_orders")
    log.append("work orders to delete: %d" % victims)

    # Rows that are meaningless without their work order.
    children = [
        "labor_records", "wo_parts", "wo_costs", "wo_actions",
        "work_order_stock_items",
    ]
    # Rows that survive the work order and only lose the pointer.
    detach = [
        "maintenance_tickets", "predictive_alerts", "supplier_orders",
        "machine_history", "alerts", "inventory_movements", "cost_audit_log",
    ]

    counts = {}
    for table in children:
        counts[table] = await conn.fetchval(
            "SELECT count(*) FROM %s WHERE work_order_id IS NOT NULL" % table
        )
    for table in detach:
        counts[table] = await conn.fetchval(
            "SELECT count(*) FROM %s WHERE work_order_id IS NOT NULL" % table
        )
    counts["failure_events"] = await conn.fetchval(
        "SELECT count(*) FROM failure_events WHERE source = 'work_order'"
    )
    counts["plan_occurrences"] = await conn.fetchval(
        "SELECT count(*) FROM plan_occurrences WHERE work_order_id IS NOT NULL"
    )
    counts["work_order_technicians"] = await conn.fetchval(
        "SELECT count(*) FROM work_order_technicians"
    )
    for table, n in sorted(counts.items()):
        if n:
            log.append("  %-26s %d" % (table, n))

    if not apply_changes:
        return counts

    # break the circular FK from the work-order side first
    await conn.execute("UPDATE work_orders SET occurrence_id = NULL")
    # predictive read-model derived FROM work orders (failure_patterns cascade off it)
    await conn.execute("DELETE FROM failure_events WHERE source = 'work_order'")
    for table in detach:
        await conn.execute("UPDATE %s SET work_order_id = NULL "
                           "WHERE work_order_id IS NOT NULL" % table)
    await conn.execute("UPDATE plan_occurrences SET work_order_id = NULL "
                       "WHERE work_order_id IS NOT NULL")
    for table in children:
        await conn.execute("DELETE FROM %s" % table)
    # work_order_technicians and sap_cost_links cascade with the parent row
    await conn.execute("DELETE FROM work_orders")
    return counts


async def resolve_plants(conn, records, log):
    rows = await conn.fetch("SELECT id, name FROM plants")
    by_name = dict((norm_name(r["name"]), r["id"]) for r in rows)
    mapping = {}
    for name in sorted(set(r["plant_name"] for r in records if r["plant_name"])):
        pid = by_name.get(norm_name(name))
        if pid is None:
            raise SystemExit("!! no plant in the database matches %r" % name)
        mapping[name] = pid
        log.append("plant %-34s -> %s" % (name, pid))
    return mapping


async def resolve_equipment(conn, records, plant_ids, apply_changes, log):
    """Match on (code, plant). Anything the catalogue does not have is created
    INACTIVE with its real Interal code and description -- never matched to a
    different machine by name similarity."""
    rows = await conn.fetch("SELECT id, code, plant_id, location FROM equipment")
    by_key = dict(((r["code"], r["plant_id"]), r["id"]) for r in rows)
    known_location = dict((r["id"], r["location"]) for r in rows)

    wanted = {}
    for r in records:
        plant_id = plant_ids[r["plant_name"]]
        key = (r["equipment_code"], plant_id)
        entry = wanted.get(key)
        if entry is None:
            entry = {
                "code": r["equipment_code"],
                "plant_id": plant_id,
                "description": r["equipment_description"],
                "source_equipment_id": r["legacy_meta"]["source_equipment_id"],
                "n": 0,
                "loc": Counter(),
            }
            wanted[key] = entry
        entry["n"] += 1
        if r["location"]:
            entry["loc"][r["location"]] += 1

    matched = {k: v for k, v in wanted.items() if k in by_key}
    missing = {k: v for k, v in wanted.items() if k not in by_key}
    log.append("equipment matched in catalogue : %d  (%d work orders)"
               % (len(matched), sum(v["n"] for v in matched.values())))
    log.append("equipment to create as inactive: %d  (%d work orders)"
               % (len(missing), sum(v["n"] for v in missing.values())))

    created = []
    for key, e in sorted(missing.items(), key=lambda kv: -kv[1]["n"]):
        name = (e["description"] or e["code"])[:200]
        location = (e["loc"].most_common(1)[0][0] if e["loc"] else None)
        new_id = uuid.uuid4()
        created.append({
            "id": new_id, "code": e["code"], "name": name,
            "plant_id": e["plant_id"],
            "location": location[:200] if location else None,
            "import_ref": e["source_equipment_id"], "work_orders": e["n"],
        })
        by_key[key] = new_id
        known_location[new_id] = location

    if apply_changes and created:
        await conn.executemany(
            "INSERT INTO equipment "
            "  (id, plant_id, code, name, description, location, status, active,"
            "   asset_type, created_at, import_source, import_ref) "
            "VALUES ($1,$2,$3,$4,$5,$6,'inactive',false,'production',now(),$7,$8) "
            "ON CONFLICT (import_source, import_ref) WHERE import_source IS NOT NULL "
            "DO NOTHING",
            [(c["id"], c["plant_id"], c["code"], c["name"],
              "Interal historical asset – retired or not in the current catalogue",
              c["location"], IMPORT_SOURCE, c["import_ref"]) for c in created],
        )
    return by_key, known_location, created


async def resolve_people(conn, records, log):
    """Exact employee number, then exact name with accents and case folded.
    Nothing else -- and no account is ever created."""
    rows = await conn.fetch(
        "SELECT t.id AS technician_id, t.user_id, t.employee_number, u.name "
        "FROM technicians t JOIN users u ON u.id = t.user_id"
    )
    by_number = {}
    by_name = {}
    for r in rows:
        if r["employee_number"]:
            by_number[r["employee_number"].strip()] = (r["technician_id"], r["user_id"], r["name"])
        by_name[norm_name(r["name"])] = (r["technician_id"], r["user_id"], r["name"])

    resolved = {}
    stats = Counter()
    seen = Counter()
    for r in records:
        raw = r["legacy_meta"]["employee_responsible"]
        if not raw:
            stats["no_responsible_on_record"] += 1
            continue
        seen[raw] += 1
        if raw in resolved:
            continue
        hit = None
        how = None
        if r["technician_employee_number"] and r["technician_employee_number"] in by_number:
            hit, how = by_number[r["technician_employee_number"]], "employee_number"
        elif r["technician_name"] and norm_name(r["technician_name"]) in by_name:
            hit, how = by_name[norm_name(r["technician_name"])], "exact_name"
        resolved[raw] = (hit, how)

    for raw, (hit, how) in resolved.items():
        stats["linked_" + how if how else "unlinked"] += seen[raw]
    log.append("responsibles distinct: %d  linked: %d  unlinked: %d"
               % (len(resolved),
                  sum(1 for h, _ in resolved.values() if h),
                  sum(1 for h, _ in resolved.values() if not h)))
    for k in sorted(stats):
        log.append("  %-28s %d work orders" % (k, stats[k]))
    return resolved


# A historical order that Interal already closed is not waiting for a KAIZO
# sign-off. Left at the model default ("pending") the 63 283 closed rows would
# land in the approval queue, which selects status=completed AND
# approval_status='pending' (wo_approval.py:244-248). They are marked approved
# with no approver and a note saying why, so the queue keeps working normally.
APPROVAL_NOTE = "Imported historical work order (Interal export) — not a KAIZO approval"

INSERT_SQL = """
INSERT INTO work_orders (
    id, wo_number, equipment_id, plant_id, created_by_id, assigned_to_id, executor_id,
    type, priority, status, title, short_description, description, diagnostic, resolution,
    opened_at, due_date, completed_at, close_date, estimated_hours,
    source, from_iot, completion_ratio, checklist_enforcement,
    approval_status, approval_note,
    legacy_technician, legacy_location, import_source, import_ref, legacy_meta,
    created_at
) VALUES (
    $1,$2,$3,$4,NULL,$5,$6,
    $7,$8,$9,$10,$11,$12,$13,$14,
    $15,NULL,$16,$17,$18,
    'manual',false,$19,'advisory',
    $20,$21,
    $22,$23,$24,$25,$26,
    now()
)
ON CONFLICT (import_source, import_ref) WHERE import_source IS NOT NULL DO UPDATE SET
    wo_number         = EXCLUDED.wo_number,
    equipment_id      = EXCLUDED.equipment_id,
    plant_id          = EXCLUDED.plant_id,
    assigned_to_id    = EXCLUDED.assigned_to_id,
    executor_id       = EXCLUDED.executor_id,
    type              = EXCLUDED.type,
    priority          = EXCLUDED.priority,
    status            = EXCLUDED.status,
    title             = EXCLUDED.title,
    short_description = EXCLUDED.short_description,
    description       = EXCLUDED.description,
    diagnostic        = EXCLUDED.diagnostic,
    resolution        = EXCLUDED.resolution,
    opened_at         = EXCLUDED.opened_at,
    completed_at      = EXCLUDED.completed_at,
    close_date        = EXCLUDED.close_date,
    estimated_hours   = EXCLUDED.estimated_hours,
    approval_status   = EXCLUDED.approval_status,
    approval_note     = EXCLUDED.approval_note,
    legacy_technician = EXCLUDED.legacy_technician,
    legacy_location   = EXCLUDED.legacy_location,
    legacy_meta       = EXCLUDED.legacy_meta
"""


def build_rows(records, plant_ids, equipment_ids, people, stats):
    rows = []
    for r in records:
        plant_id = plant_ids[r["plant_name"]]
        equipment_id = equipment_ids[(r["equipment_code"], plant_id)]

        raw_person = r["legacy_meta"]["employee_responsible"]
        hit, _how = people.get(raw_person, (None, None)) if raw_person else (None, None)
        technician_id = hit[0] if hit else None
        user_id = hit[1] if hit else None
        # The historical name is kept on every order, matched or not, so the
        # Technician column never goes blank for a person who has no account.
        legacy_technician = (r["technician_name"] or raw_person or None)
        if legacy_technician:
            legacy_technician = legacy_technician[:200]

        closed = r["status"] in ("completed", "cancelled")
        completed_at = parse_dt(r["completed_at"])
        approval_status = "approved" if closed else "pending"
        approval_note = APPROVAL_NOTE if closed else None
        if closed:
            stats["approval_preset_approved"] += 1

        # The title already carries this sentence (SMALL_REMARK is <=100 chars and
        # is both the title and the requested-work block). Filling
        # short_description too would print it a third and fourth time on the
        # detail page -- as the header subtitle and as its own card.
        short_desc = None

        rows.append((
            uuid.uuid4(), r["wo_number"], equipment_id, plant_id,
            user_id, technician_id,
            r["type"], r["priority"], r["status"], r["title"], short_desc,
            r["description"], r["diagnostic"], r["resolution"],
            parse_dt(r["opened_at"]), completed_at,
            completed_at.date() if completed_at else None,
            r["estimated_hours"],
            100.0 if r["status"] == "completed" else 0.0,
            approval_status, approval_note,
            legacy_technician,
            (r["location"] or None),
            IMPORT_SOURCE, r["import_ref"],
            json.dumps(r["legacy_meta"], ensure_ascii=False),
        ))
    return rows


async def run(args):
    records = []
    with open(args.records, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    if not records:
        raise SystemExit("!! no records in %s" % args.records)

    log = []
    stats = Counter()
    log.append("records to load: %d" % len(records))
    log.append("mode: %s%s" % ("APPLY" if args.apply else "DRY RUN",
                               " + REPLACE" if args.replace else ""))

    conn = await asyncpg.connect(PG_URL)
    try:
        tx = conn.transaction()
        await tx.start()
        committed = False
        try:
            log.append("\n## schema")
            await ensure_schema(conn, args.apply, log)
            if not args.apply:
                # The rest of the plan needs the new columns to exist. In a dry
                # run they are created inside a transaction that is rolled back,
                # so the database is left exactly as it was found.
                await ensure_schema(conn, True, [])

            log.append("\n## purge")
            if args.replace:
                await purge_work_orders(conn, args.apply, log)
            else:
                log.append("skipped (no --replace): load is a pure upsert")

            log.append("\n## plants")
            plant_ids = await resolve_plants(conn, records, log)

            log.append("\n## equipment")
            equipment_ids, _locations, created_equipment = await resolve_equipment(
                conn, records, plant_ids, args.apply, log
            )

            log.append("\n## people")
            people = await resolve_people(conn, records, log)

            log.append("\n## work orders")
            rows = build_rows(records, plant_ids, equipment_ids, people, stats)
            if args.apply:
                batch = 2000
                for i in range(0, len(rows), batch):
                    await conn.executemany(INSERT_SQL, rows[i:i + batch])
                    print("  inserted %d/%d" % (min(i + batch, len(rows)), len(rows)),
                          file=sys.stderr)
                loaded = await conn.fetchval(
                    "SELECT count(*) FROM work_orders WHERE import_source = $1",
                    IMPORT_SOURCE,
                )
                total = await conn.fetchval("SELECT count(*) FROM work_orders")
                log.append("rows written : %d" % len(rows))
                log.append("in database  : %d imported / %d total work orders"
                           % (loaded, total))
            else:
                log.append("rows prepared: %d (not written — dry run)" % len(rows))
            log.append("closed orders pre-approved: %d"
                       % stats["approval_preset_approved"])
            log.append("equipment created inactive: %d" % len(created_equipment))

            if args.apply:
                await tx.commit()
                committed = True
                log.append("\nCOMMITTED")
        finally:
            if not committed:
                await tx.rollback()
                if not args.apply:
                    log.append("\nROLLED BACK — dry run, database untouched")
    finally:
        await conn.close()

    text = "\n".join(log)
    print(text)
    if args.report:
        Path(args.report).write_text(
            "# Interal work-order load\n\n```\n%s\n```\n" % text, encoding="utf-8"
        )
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--records", required=True,
                    help="work_orders.jsonl from interal_wo_transform.py")
    ap.add_argument("--apply", action="store_true",
                    help="write to the database (without it nothing is committed)")
    ap.add_argument("--replace", action="store_true",
                    help="purge the current work-order base before loading")
    ap.add_argument("--report", default=None, help="markdown report to write")
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
