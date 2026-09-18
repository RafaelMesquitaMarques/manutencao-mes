# Interal work-order history — reconciliation report

Source: `bonsdetravail_170926` export (2026-09-17), read from the **CSV**.

## Source accounting — every row is accounted for

| | .xlsx (supplied) | .csv (used) |
|---|---|---|
| physical rows after the header | 74,042 | 74,043 |
| blank rows | 941 | — (inside quoted text) |
| records split across several rows | 4,572 | 0 |
| **work orders** | **65,843** | **65,843** |
| malformed / unparseable | — | 0 |

Record sets identical: **True** (ids only in CSV: 0, only in xlsx: 0).

The 4,572 records the xlsx breaks apart are exactly the 4,559 records whose text contains a line break, plus 13 whose only break was trailing whitespace. Nothing was dropped and nothing was guessed.

## What was imported

**Status** — completed: 57,896, cancelled: 5,387, open: 1,788, on_hold: 549, in_progress: 223

**Type** — corrective: 47,380, preventive: 18,353, improvement: 110

**Priority** — critical: 32,333, medium: 20,306, high: 9,110, low: 4,094

**Plant** — Foliot Furniture (Saint-Jérôme): 63,066, Foliot Furniture (Mirabel): 2,777

## Text blocks preserved

- Requested work (`SMALL_REMARK`): **64,011**
- Diagnosis (`DIAGNOSIS`): **17,620** shown as its own block (+21,679 identical to the requested work, kept once instead of twice)
- Solution (`SOLUTION`): **47,647**
- Records with none of the three: 1,366 (title built from request code + equipment)

## Columns ignored

**82 of 135 columns are empty in every one of the 65,843 records** and nothing was mapped from them. Notably `DATE_DUE` (so Due Date is legitimately blank everywhere), `LOCATION`, `TOTAL_COST`, `DATE_REALISATION`, `ARRIVAL_DATETIME` and `DATA01`–`DATA24`.

<details><summary>All 82</summary>

`DESCRIPTION`, `NO_SECTION`, `TAG`, `AREA`, `REQUESTED_BY`, `REQUESTED_FOR`, `LOCATION`, `NO_PURCHASE_ORDER`, `ARRIVAL_DATETIME`, `F_BILLABLE`, `F_APPROVED`, `F_BILLED`, `NO_WO_PRIORITY`, `BT_DESCRIPTION`, `REMARK_REQUEST_CODE`, `DATE_REALISATION`, `NO_WO_REPAIR_CLASS`, `NO_WO_EXECUTION_MODE`, `NO_EXPENSE_ACCOUNT`, `FAILURE_TIME`, `NO_CUSTOMER`, `NAME`, `ID_SECTION_TAG`, `ID_EXPENSE_ACCOUNT`, `TIME_PLAN`, `EQUIPMENT_DIVISION`, `PLANT_NAME`, `EQUIPMENT_GROUP`, `SUITE`, `NO_WO_REQUEST_CODE`, `EQUIPMENT_LOCATION`, `EQUIPMENT_DIVISION1`, `NO_STANDARD_TASK`, `STANDARD_TASK_DESC`, `NO_WORK_ORDER_HEADER_PARENT`, `EQUIPMENT_METER`, `METER_EMISSION_VALUE`, `METER_CLOSING_VALUE`, `TIME_DONE`, `NO_EQUIPMENT_STATUS`, `NO_EQUIPMENT_CRITICALITY`, `TOTAL_COST`, `DATA01`, `DATA02`, `DATA03`, `DATA04`, `DATA05`, `DATA06`, `DATA07`, `DATA08`, `DATA09`, `DATA10`, `DATA11`, `DATA12`, `DATA13`, `DATA14`, `DATA15`, `DATA16`, `DATA17`, `DATA18`, `DATA19`, `DATA20`, `DATA21`, `DATA22`, `DATA23`, `DATA24`, `No_TOOL_GROUP`, `NO_RESOURCE`, `NO_DEPARTMENT`, `RESOURCE_TIME_PLAN`, `PRINT_BATCH`, `REMARK`, `NO_WORK_ORDER_PREV`, `NO_LOCATION`, `LINE_NO`, `EXPENSE_ACCOUNT_DESC`, `OTHER_TOOK_ACTION`, `NO_WORK_REQUEST_PARENT`, `DATE_DUE`, `NO_PROJECT_HEADER`, `NO_WO_CAUSE`, `EQUIPMENT_SUB_DIVISION`

</details>

## Judgement calls, and what was deliberately NOT inferred

- **2,438 records carry a `DATE_CLOSE` but a status that is not closed** (203 of the 223 `0. En cours` rows have one). `DATE_CLOSE` is not a completion marker in this export, so it was only honoured where the status agrees.
- **42 completed orders have no close date.** Left empty — no date invented.
- **57 orders carry a retired `-Innactif*` status** and **225 carry none**. All are closed in the source (`F_ACTIVE=false` + a close date) but the outcome is unrecoverable; they were mapped to `completed` with the raw label kept in `legacy_meta`.
- **124 orders have no priority code** → `medium`.
- **1,558 orders have no free text**; the title was built from the request code and the equipment description, both always present.
- `DATE_START` was **not** mapped to any operational field: it precedes `DATE_OPEN` on 7,338 records and equals it on 42,018, so it behaves like a planned start, not an actual one. Kept in `legacy_meta`.
- `TOTAL_MAN_HOURS` was **not** read as hours worked: it is byte-identical to `TOTAL_TIME_PLAN` on 65,840 of 65,843 rows and exactly 2× it on the other 3. Only the planned minutes were mapped, to `estimated_hours`. No cost, downtime or repair time was inferred.

## Unreconstructable records

**None.** All 65,843 records parsed with 135 fields, 0 duplicates, 0 missing work-order number, 0 missing open date. A field-by-field comparison of the imported text against the source CSV over all 65,843 × 3 text fields returned **0 mismatches**. No re-export is needed.

Two work-order numbers are non-standard in the source itself and were preserved verbatim: `2019-000308` (11 chars) and `2013`.