"""Interal `bonsdetravail` export -> normalized KAIZO work-order records.

Pure transform: reads the Interal CSV, emits one JSON object per historical work
order plus a reconciliation report. Touches no database, so it can be run and
reviewed before anything is deleted.

Why the CSV and not the .xlsx: both are the same 2026-09-17 export and carry the
identical set of 65 843 ID_WORK_ORDER_HEADER values, but the xlsx was converted
by a reader that lost CSV quote state at embedded newlines. In the xlsx a work
order whose DIAGNOSIS/SOLUTION spans lines is split across several physical rows
with the remaining columns shifted, and its accented text is double-encoded
("Complete" -> mojibake). The CSV holds those fields intact, correctly UTF-8.
See `--verify-xlsx` for the equivalence check.

Usage:
    python interal_wo_transform.py --csv <path> --out <dir> [--verify-xlsx <path>]
"""
from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

csv.field_size_limit(10 ** 9)

IMPORT_SOURCE = "interal_bonsdetravail"
N_COLUMNS = 135

# ─── Source value legends ──────────────────────────────────────────────────────
# ID_WO_PRIORITY has no label column in this export (NO_WO_PRIORITY is empty in
# all 65 843 rows). The legend below comes from the sibling Interal export
# `liste_des_requetes`, where both columns are populated. It is a response-time
# scale, not a severity rank -- id 1 is the MOST urgent, and the id order is not
# the label order (id 8 = "2. Quart de travail" sits between ids 1 and 2).
PRIORITY_LABELS = {
    "1": "1. Urgence",
    "8": "2. Quart de travail",
    "2": "3. Aujourd'hui",
    "3": "3. Demain",
    "4": "4. 1 Semaine",
    "7": "5. 2 Semaines",
    "5": "6. 1 Mois",
    "6": "7. 6 Mois",
}
PRIORITY_MAP = {
    "1": "critical",   # Urgence
    "8": "high",       # Quart de travail
    "2": "high",       # Aujourd'hui
    "3": "medium",     # Demain
    "4": "medium",     # 1 Semaine
    "7": "low",        # 2 Semaines
    "5": "low",        # 1 Mois
    "6": "low",        # 7. 6 Mois
}
PRIORITY_DEFAULT = "medium"

# NO_WO_STATUS carries the real workflow state. Its numeric prefix is a display
# order, NOT a priority -- "3. Priorite #3" is an open/queued state, not a
# priority 3. Mapped onto WorkOrderStatus(open|in_progress|on_hold|completed|cancelled).
STATUS_MAP = {
    "4. Complété": "completed",
    "5. Annulé": "cancelled",
    "0. En cours": "in_progress",
    # queued/triage states
    "1. Priorité #1": "open",
    "2. Priorité #2": "open",
    "3. Priorité #3": "open",
    ".Bon de travail incomplet": "open",
    ".Demande Mise a jour": "open",
    "8a. Technicien demandé": "open",
    "8b. Technicien en soumission": "open",
    "8c. Technicien Planifié": "open",
    # blocked, waiting on something
    "7a. Pièces demandées": "on_hold",
    "7b. Pièces en soumission": "on_hold",
    "7c. Pièces commandées": "on_hold",
    "7e. Pièces reçues": "on_hold",
    "6a. Attente d'une décision": "on_hold",
    "6b. Attente production": "on_hold",
}
# Retired Interal statuses. All carry F_ACTIVE=False and a DATE_CLOSE, so the
# record is closed, but the outcome is not recoverable from the export. Mapped to
# `completed` with the raw label kept in legacy_meta for a later re-map.
STATUS_RETIRED = {
    "-Innactif1", "-Innactif2", "-Innactif3", "-Innactif4",
    "-Innactif5", "-Innactif6", "-Innactif7",
}

# TYPE: 1 <-> F_WO_CORRECTIVE=1, 2 <-> F_WO_PREVENTIVE=True, 4 <-> F_WO_ANTICIPATED=True
# (each correspondence is exact across all 65 843 rows). DESC_REQUEST_CODE is
# checked first because "3. Projet" is improvement work regardless of TYPE.
TYPE_BY_REQUEST = {"3. Projet": "improvement"}

PLANT_BY_SOURCE_ID = {
    "1": "Foliot Furniture (Saint-Jérôme)",
    "3": "Foliot Furniture (Mirabel)",
}

TRUE_SET = {"true", "1", "yes"}


def norm_name(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().lower()


def parse_dt(s: str):
    s = (s or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None


def parse_num(s: str):
    """Interal writes decimals French-style: '30,000000'."""
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s.replace(",", "."))
    except ValueError:
        return None


def split_employee(s: str):
    """'16525 - Olivier Pronovost' -> ('16525', 'Olivier Pronovost')."""
    s = (s or "").strip()
    if not s:
        return None, None
    if " - " in s:
        num, name = s.split(" - ", 1)
        return num.strip() or None, name.strip() or None
    return None, s


def location_from_path(path: str) -> str | None:
    """PATH is 'Plant,Department, Sub-area[, equipment]'. The plant root is
    already the WO's plant, so Location is everything after it."""
    parts = [p.strip() for p in (path or "").split(",")]
    tail = [p for p in parts[1:] if p]
    return " / ".join(tail) if tail else None


def build_record(row: list[str], H: dict[str, int], report: dict) -> dict:
    g = lambda name: (row[H[name]] or "").strip()

    src_id = g("ID_WORK_ORDER_HEADER")
    wo_number = g("NO_WORK_ORDER_HEADER")

    # ── texts ────────────────────────────────────────────────────────────────
    requested = g("SMALL_REMARK")
    diagnosis = g("DIAGNOSIS")
    solution = g("SOLUTION")

    # SMALL_REMARK is a copy of DIAGNOSIS in 21 679 records. Keep it once, as the
    # requested-work block, and leave the diagnosis block empty rather than
    # printing the same paragraph twice. Nothing is lost: the texts are equal.
    diagnosis_block = "" if (diagnosis and diagnosis == requested) else diagnosis
    if diagnosis and not diagnosis_block:
        report["diagnosis_same_as_remark"] += 1

    # ── title ────────────────────────────────────────────────────────────────
    # SMALL_REMARK is <=100 chars in every record, so it is used whole.
    title = requested or diagnosis
    if not title:
        # 1 366 records carry no free text at all (mostly routine PM). Build the
        # title from the request code + equipment, both always populated.
        bits = [g("DESC_REQUEST_CODE"), g("EQUP_DESCRIPTION")]
        title = " – ".join(b for b in bits if b) or f"WO {wo_number}"
        report["title_from_fallback"] += 1
    title = " ".join(title.split())[:500]

    # ── type ─────────────────────────────────────────────────────────────────
    request_code = g("DESC_REQUEST_CODE")
    src_type = g("TYPE")
    if request_code in TYPE_BY_REQUEST:
        wo_type = TYPE_BY_REQUEST[request_code]
    elif src_type == "2" or g("F_WO_PREVENTIVE").lower() in TRUE_SET:
        wo_type = "preventive"
    else:
        wo_type = "corrective"

    # ── priority ─────────────────────────────────────────────────────────────
    src_prio = g("ID_WO_PRIORITY")
    priority = PRIORITY_MAP.get(src_prio, PRIORITY_DEFAULT)
    if src_prio not in PRIORITY_MAP:
        report["priority_missing"] += 1

    # ── status ───────────────────────────────────────────────────────────────
    src_status = g("NO_WO_STATUS")
    if src_status in STATUS_MAP:
        status = STATUS_MAP[src_status]
    elif src_status in STATUS_RETIRED:
        status = "completed"
        report["status_retired"] += 1
    elif not src_status:
        # 225 rows: 224 are closed (F_ACTIVE=False + DATE_CLOSE), 1 is still active.
        closed = g("F_ACTIVE").lower() not in TRUE_SET and bool(g("DATE_CLOSE"))
        status = "completed" if closed else "open"
        report["status_blank"] += 1
    else:
        status = "open"
        report["status_unmapped"][src_status] += 1

    # ── dates ────────────────────────────────────────────────────────────────
    # Every date in this export is midnight-exact (0 of 65 843 carry a time), so
    # they are date-only values. They are emitted naive and stored as-is; no
    # timezone conversion is applied, which is what would shift the day.
    opened_at = parse_dt(g("DATE_OPEN"))
    date_close = parse_dt(g("DATE_CLOSE"))
    date_start = parse_dt(g("DATE_START"))

    # DATE_CLOSE is populated on 99.7% of records INCLUDING 203 of the 223 rows
    # still "0. En cours" and all 460 "Pieces recues" -- so it is not a
    # completion marker on its own. Only honour it when the state agrees.
    completed_at = date_close if status in ("completed", "cancelled") else None
    if date_close and completed_at is None:
        report["close_date_ignored_open_wo"] += 1
    if status == "completed" and completed_at is None:
        # 42 completed records have no DATE_CLOSE. No date is invented.
        report["completed_without_close_date"] += 1

    # DATE_DUE is empty in all 65 843 records -> due_date stays NULL.
    # DATE_START precedes DATE_OPEN on 7 338 records and equals it on 42 018, so
    # it behaves like a planned/target start, not an actual intervention start.
    # It is preserved in legacy_meta and deliberately not mapped to started_at.

    # ── planned time ─────────────────────────────────────────────────────────
    # TOTAL_TIME_PLAN is minutes (values sit on a 5/15/30/60/480/2880 grid).
    # TOTAL_MAN_HOURS is byte-identical to it in 65 840 of 65 843 rows and is
    # 2x it in the other 3, i.e. planned man-minutes -- NOT hours worked. Neither
    # feeds repair_hours, downtime or cost.
    plan_minutes = parse_num(g("TOTAL_TIME_PLAN")) or 0.0
    estimated_hours = round(plan_minutes / 60.0, 4) if plan_minutes > 0 else None

    # ── people ───────────────────────────────────────────────────────────────
    resp_num, resp_name = split_employee(g("EMPLOYEE_RESPONSIBLE"))

    return {
        "import_source": IMPORT_SOURCE,
        "import_ref": src_id,
        "wo_number": wo_number,
        "title": title,
        "type": wo_type,
        "priority": priority,
        "status": status,
        "opened_at": opened_at.isoformat() if opened_at else None,
        "completed_at": completed_at.isoformat() if completed_at else None,
        "due_date": None,
        "estimated_hours": estimated_hours,
        # text blocks, verbatim (newlines preserved)
        "description": requested or None,
        "diagnostic": diagnosis_block or None,
        "resolution": solution or None,
        # lookup keys, resolved against the live DB by the loader
        "source_plant_id": g("ID_PLANT"),
        "plant_name": PLANT_BY_SOURCE_ID.get(g("ID_PLANT")),
        "equipment_code": g("NO_EQUIPMENT"),
        "equipment_description": g("EQUP_DESCRIPTION"),
        "location": location_from_path(g("PATH")),
        "technician_employee_number": resp_num,
        "technician_name": resp_name,
        # everything else worth keeping, for audit and re-mapping
        "legacy_meta": {
            "source_status": src_status,
            "source_priority_id": src_prio,
            "source_priority_label": PRIORITY_LABELS.get(src_prio),
            "source_type": src_type,
            "request_code": request_code,
            "path": g("PATH"),
            "date_start": date_start.isoformat() if date_start else None,
            "date_close": date_close.isoformat() if date_close else None,
            "employee_responsible": g("EMPLOYEE_RESPONSIBLE") or None,
            "employee_sender": g("EMPLOYEE_SENDER") or None,
            "employee_receiver": g("EMPLOYEE_RECEIVER") or None,
            "total_time_plan_minutes": plan_minutes or None,
            "total_man_hours_raw": parse_num(g("TOTAL_MAN_HOURS")) or None,
            "f_active": g("F_ACTIVE"),
            "source_equipment_id": g("ID_EQUIPMENT"),
            "repair_class_id": g("ID_WO_REPAIR_CLASS") or None,
            "execution_mode_id": g("ID_EXECUTION_MODE") or None,
            "preventive_header_id": g("ID_WORK_ORDER_HEADER_PREVENTIVE") or None,
            "material_status": g("MATERIAL_STATUS") or None,
        },
    }


def verify_against_xlsx(xlsx_path, csv_ids):
    """Prove the CSV is the same export as the .xlsx supplied by the user, and
    that the xlsx's broken rows are exactly the CSV's multi-line text fields."""
    try:
        import openpyxl
    except ImportError:
        return {"skipped": "openpyxl not installed"}

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb[wb.sheetnames[0]]
    anchors = set()
    physical = 0
    split_records = 0
    blank_rows = 0
    seen_first = False
    pending = False
    for i, row in enumerate(ws.iter_rows(values_only=True)):
        if i == 0:
            continue
        physical += 1
        a, b = row[0], row[1]
        is_anchor = (
            isinstance(a, (int, float)) and not isinstance(a, bool)
            and b is not None and b != ""
        )
        if is_anchor:
            anchors.add(str(int(a)))
            pending = False
            seen_first = True
        elif all(c is None or c == "" for c in row):
            blank_rows += 1
        elif seen_first:
            if not pending:
                split_records += 1
                pending = True
    return {
        "xlsx_physical_rows": physical,
        "xlsx_anchor_records": len(anchors),
        "xlsx_blank_rows": blank_rows,
        "xlsx_records_split_across_rows": split_records,
        "ids_in_csv_not_in_xlsx": sorted(csv_ids - anchors)[:20],
        "ids_in_xlsx_not_in_csv": sorted(anchors - csv_ids)[:20],
        "record_sets_identical": csv_ids == anchors,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--verify-xlsx", default=None)
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    report = {
        "diagnosis_same_as_remark": 0,
        "title_from_fallback": 0,
        "priority_missing": 0,
        "status_retired": 0,
        "status_blank": 0,
        "status_unmapped": Counter(),
        "close_date_ignored_open_wo": 0,
        "completed_without_close_date": 0,
    }

    with open(args.csv, newline="", encoding="utf-8") as fh:
        rdr = csv.reader(fh)
        header = next(rdr)
        if len(header) != N_COLUMNS:
            print("!! expected %d columns, got %d" % (N_COLUMNS, len(header)), file=sys.stderr)
            return 2
        H = dict((name, i) for i, name in enumerate(header))
        rows = []
        malformed = []
        for n, row in enumerate(rdr, start=2):
            if not any(c.strip() for c in row):
                continue
            if len(row) != N_COLUMNS:
                malformed.append({"line": n, "n_fields": len(row), "head": row[:4]})
                continue
            rows.append(row)

    # Columns empty across the whole export -- nothing is mapped from them.
    filled = Counter()
    for row in rows:
        for i, val in enumerate(row):
            if val and val.strip():
                filled[header[i]] += 1
    empty_columns = [h for h in header if filled[h] == 0]

    records = [build_record(row, H, report) for row in rows]

    dup_number = [k for k, v in Counter(r["wo_number"] for r in records).items() if v > 1]
    dup_ref = [k for k, v in Counter(r["import_ref"] for r in records).items() if v > 1]
    missing_number = [r["import_ref"] for r in records if not r["wo_number"]]
    missing_opened = [r["wo_number"] for r in records if not r["opened_at"]]
    multiline = sum(
        1 for r in records
        if any("\n" in (r[k] or "") for k in ("description", "diagnostic", "resolution"))
    )

    with open(out_dir / "work_orders.jsonl", "w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    # Distinct equipment the loader must resolve.
    equip = {}
    for r in records:
        key = (r["equipment_code"], r["source_plant_id"])
        e = equip.get(key)
        if e is None:
            e = {
                "code": r["equipment_code"],
                "source_plant_id": r["source_plant_id"],
                "plant_name": r["plant_name"],
                "description": r["equipment_description"],
                "source_equipment_id": r["legacy_meta"]["source_equipment_id"],
                "work_orders": 0,
                "_loc": Counter(),
            }
            equip[key] = e
        e["work_orders"] += 1
        if r["location"]:
            e["_loc"][r["location"]] += 1
    equip_list = []
    for e in equip.values():
        loc = e.pop("_loc")
        e["location"] = loc.most_common(1)[0][0] if loc else None
        equip_list.append(e)
    equip_list.sort(key=lambda e: -e["work_orders"])
    with open(out_dir / "equipment.json", "w", encoding="utf-8") as fh:
        json.dump(equip_list, fh, ensure_ascii=False, indent=2)

    people = Counter()
    for r in records:
        raw = r["legacy_meta"]["employee_responsible"]
        if raw:
            people[raw] += 1
    with open(out_dir / "employees.json", "w", encoding="utf-8") as fh:
        json.dump([{"raw": k, "work_orders": v} for k, v in people.most_common()],
                  fh, ensure_ascii=False, indent=2)

    summary = {
        "source_csv": args.csv,
        "rows_parsed": len(rows),
        "records_built": len(records),
        "malformed_rows_skipped": malformed,
        "empty_columns_ignored": {"count": len(empty_columns), "names": empty_columns},
        "records_with_multiline_text": multiline,
        "distinct_equipment": len(equip_list),
        "distinct_responsibles": len(people),
        "by_status": dict(Counter(r["status"] for r in records)),
        "by_type": dict(Counter(r["type"] for r in records)),
        "by_priority": dict(Counter(r["priority"] for r in records)),
        "by_plant": dict(Counter(r["plant_name"] for r in records)),
        "text_blocks": {
            "description": sum(1 for r in records if r["description"]),
            "diagnostic": sum(1 for r in records if r["diagnostic"]),
            "resolution": sum(1 for r in records if r["resolution"]),
            "none_of_the_three": sum(
                1 for r in records
                if not r["description"] and not r["diagnostic"] and not r["resolution"]
            ),
        },
        "dates": {
            "with_opened_at": sum(1 for r in records if r["opened_at"]),
            "with_completed_at": sum(1 for r in records if r["completed_at"]),
            "with_due_date": sum(1 for r in records if r["due_date"]),
        },
        "notes": dict(
            (k, dict(v) if isinstance(v, Counter) else v) for k, v in report.items()
        ),
        "integrity": {
            "duplicate_wo_number": dup_number,
            "duplicate_import_ref": dup_ref,
            "missing_wo_number": missing_number,
            "missing_opened_at": missing_opened,
        },
    }
    if args.verify_xlsx:
        summary["xlsx_equivalence"] = verify_against_xlsx(
            Path(args.verify_xlsx), set(r["import_ref"] for r in records)
        )

    with open(out_dir / "summary.json", "w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
