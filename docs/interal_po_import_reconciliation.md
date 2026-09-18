# Interal purchase-order import — reconciliation

Replacement of the demo purchase orders by the real ones extracted from Interal
(`PO_170926.csv`, 2026-09-17 extraction). Applied 2026-09-18.

This extraction is **not a full purchase history**. It contains only orders that
were still OPEN or PARTIAL at extraction time — no closed or completed orders —
and no line-level detail at all.

## Result

| | |
|---|---|
| Demo orders deleted | 3 (`PO-2026-0001`, `PO-2026-0002`, `PO-2026-0003`) |
| Real orders imported | 10 |
| Suppliers matched | 7 of 7, by code, none created |
| Buying plant | Foliot Furniture (Saint-Jérôme) — `QS` |
| Order dates | 2025-12-16 … 2026-09-15 |
| Status | 6 `PARTIAL` → `confirmed`, 4 `OPEN` → `sent` |
| Line items created | **0** — the extraction has none |

## The file

UTF-8 (verified: `É` is `C3 89`, not a single byte — no mojibake), `;`-separated,
`,` decimal, CRLF. 41 columns, 11 physical data lines, **10 logical orders**.

### The order split across two lines

`PO-0002188` (`ID_ORDER` 2272) has a remark containing a line break, which the
exporter wrote as two physical lines. The continuation is **not** a short row —
it is padded out to the full 41 fields, so a field-count check accepts it as an
11th order. It is detected by content instead (`ID_ORDER` is not a number).

Its fields `0..7` are the order's fields `33..40` pushed right by the break — a
fixed `+33` shift, verified against a well-formed row and re-checked at load time
(every target field must be empty before it is written, and nothing may sit past
the folded tail):

| continuation field | value | folds onto |
|---|---|---|
| 0 | `BEARING LINÉAIRE / CYLINDRE PROJET RALF` | `INTERNAL_REMARK` (appended after a newline) |
| 1 | `2414,89` | `COST_GRAND_TOTAL_CURRENCY` |
| 4 | `$` | `SYMBOL` |
| 5 | `0` | `F_EMAIL` |
| 6 | `2026-09-15 00:00` | `ACCOUNTING_DATE` |
| 7 | `PARTIAL` | `UI_STATUS` |

The exporter also doubles the closing quote, so CSV parsing leaves a stray `"` at
the end of the fragment. One trailing quote is stripped as an export artifact;
nothing else is removed.

Corroboration that the fold is right: after reconstruction `STATUS == UI_STATUS`
on all 10 orders. Before it, this one row had an empty `UI_STATUS`.

## Field mapping

| Source | Destination |
|---|---|
| `ID_ORDER` | `import_ref` (+ `legacy_meta.source_id`) — idempotency key |
| `NO_ORDER` | `order_number` |
| `CUSTOMER_ORDER_NO` | `external_ref` — kept apart from `order_number` |
| `NO_CUSTOMER` | matched to `suppliers.code` (exact, leading zeros kept) |
| `ID_CUSTOMER` | `legacy_meta.supplier_source_id` — Interal's id, never our uuid |
| `CUSTOMER_NAME` | `legacy_meta.supplier_name_at_source` (display only) |
| `NAME` / `ID_PLANT` | `legacy_meta.plant_name_at_source` / `plant_source_id`; the plant is resolved by name |
| `DATE_CREATED` | `order_date` (date part) **and** `created_at` (full timestamp) |
| `ACCOUNTING_DATE` | `legacy_meta.accounting_date` — **not** a due or delivery date |
| `DATE_OPEN` | ignored (empty in every row) |
| `COST_SUB_TOTAL` | `subtotal_amount` |
| `COST_GRAND_TOTAL` | `total_amount` |
| `COST_GRAND_TOTAL_CURRENCY` | `legacy_meta.grand_total_home_currency` |
| `STATUS` / `UI_STATUS` | `status` (mapped) + `legacy_meta.source_status` (verbatim) |
| `F_APPROUVED` | `legacy_meta.approved` — separate from the operational status |
| `EMPLOYEE_APPROVAL` / `_ISSUER` / `_BUYER` | `legacy_meta.*` as text |
| `INTERNAL_REMARK` | `notes` |
| `PHONE1` / `EMAIL_TO` | `legacy_meta.contact_phone` / `contact_email` — stored, never mailed |

### Money: three figures, kept apart

`COST_SUB_TOTAL`, `COST_GRAND_TOTAL` and `COST_GRAND_TOTAL_CURRENCY` are three
different numbers and are never summed or reconciled.

`SYMBOL` is `$` on every row and names no currency. The **supplier record** does:

* On 9 of 10 orders `COST_GRAND_TOTAL == COST_GRAND_TOTAL_CURRENCY`.
* The one that differs is `PO-0002176` — 1060 vs 1484, a ratio of exactly
  **1.40000** — and its supplier, **Bruks Rockwood**, is the only one in the
  catalogue whose currency is **USD**, set long before this import.

So `COST_GRAND_TOTAL` is the total in the order's own currency and
`COST_GRAND_TOTAL_CURRENCY` is the same total restated in the plant's home
currency. `total_amount` takes the former, `currency` comes from the supplier,
and the home-currency figure is preserved in `legacy_meta` and shown on the order
only when it differs. **No exchange rate is stored or inferred.**

Subtotal and grand total also differ on three orders (`PO-0002168` 281.00 →
323.08, `PO-0002189`, `PO-0002190`). Both figures are preserved; the difference is
**not** attributed to tax, freight or anything else.

## Status mapping — and what it loses

| Source | Platform | |
|---|---|---|
| `OPEN` | `sent` | issued, nothing received — an exact fit |
| `PARTIAL` | `confirmed` | issued and acknowledged — a **superset** |

`PurchaseOrderStatus` has no partially-received state. `confirmed` is not false
for a partially-delivered order, but it does not say "some of it arrived" either.
That half of `PARTIAL` has no column to live in, so:

* the source word is kept verbatim in `legacy_meta.source_status` and shown on
  every imported order under **Status at source**;
* **no received quantity or delivery percentage is inferred from `PARTIAL`** —
  the extraction carries none.

If a partially-received status is wanted in the UI later, adding `partial` to the
enum touches `suppliers.py`, `costs.py` (`OPEN_PO_STATUSES`), the list filter,
both `STATUS_STYLE` maps and `poStatus.*` in three locales.

## No line items

The extraction has **no part codes, quantities, unit prices, received quantities
or receipt dates**. None were invented — no placeholder part, no synthetic line
to make the total add up. The orders carry the header total from the source and
show `0` in the **Items** column.

Two consequences were handled rather than left to bite:

1. `receive_purchase_order` recomputes the total from the lines, so receiving an
   order with none would have overwritten a real total with `0.00`. It now
   refuses with `po_no_items_to_receive`, and the Receive button is hidden when
   there is nothing to receive. This is a general fix, not an import-only one.
2. If lines are later added by hand, the recomputed total becomes the truth — but
   `legacy_meta.grand_total` keeps the source figure permanently.

## Empty columns (ignored, no fields or filters created)

`DATE_OPEN`, `CONTACT_NAME`, `ID_EMPLOYEE_AWAITING_APPROVAL`, `NO_DOCK_STATION`,
`ID_DOCK_STATION`, `EMPLOYEE_AWAITING_APPROVAL`, `NO_BRANCH`, `SHORT_NAME` — 8
columns, empty in all 10 rows.

Partially filled columns were kept: `EMPLOYEE_APPROVAL` (6/10),
`ID_EMPLOYEE_APPROVAL` (6/10), `PHONE1` (7/10), `EMAIL_TO` (9/10),
`INTERNAL_REMARK` (3/10).

Constant bookkeeping flags (`F_ACTIVE`, `F_RECURENCE`, `F_PRINTED`,
`F_DOCUMENT_SEND`, `F_SUPPLIER_RECEIVE_DOC`, `F_BIT_STATUS`, `F_UNLOADING_AUTO`,
`F_EMAIL`) have one value across every row and describe the source system's own
state, so they were not carried over.

## Employees

`EMPLOYEE_APPROVAL`, `EMPLOYEE_ISSUER` and `EMPLOYEE_BUYER` are
`20240130 - Karine Henry` on every row. **No user in this platform carries that
name**, and the Interal employee id (190) is not ours. Nothing was linked by name
approximation: the names are stored as text and `created_by_id` is left `NULL`.

## What the purge touched

Only the three demo orders and data that existed solely because of them:

* 3 orders, 3 lines, 1 attachment (row **and** its file in the uploads volume);
* 1 `inventory_movements` row — the receipt booked by demo `PO-2026-0003`,
  stamped `source='purchase'`, which is the only input to a part's weighted
  average cost. Left behind, it would have kept money that was never spent in the
  average of a real Interal part and pointed at a deleted order;
* on part `PA-0000503`, the `last_purchase_cost` / `last_purchase_date` that the
  same fake receipt wrote.

**Deliberately not touched:** that part's `quantity` and `average_cost`. The real
Interal stock extraction restated the quantity on 2026-09-18 (3 → 2), so reversing
a demo `+2` on top of it would have corrupted the real count. `average_cost`
(0.60) likewise comes from the real catalogue.

Suppliers, parts, equipment, users, work orders and every other shared record were
read-only. `sap_cost_links` cascades from `purchase_orders` but was empty.

## Idempotency and numbering

`(import_source, import_ref)` is a partial unique index — partial so that the
hand-made orders, which have no provenance, never collide on `(NULL, NULL)`.
Re-running the loader updates the ten rows it already wrote (verified: second run
reported `0 created, 10 updated`, still 10 orders, no duplicate suppliers or
remarks).

Imported numbers (`PO-00020xx`) do not match the generator's `PO-<year>-%` series,
so future orders still number correctly — the next one is `PO-2026-0001`.

## Reproducing

```bash
python backend/scripts/interal_po_transform.py PO_170926.csv -o po.json
python backend/scripts/interal_po_load.py --json po.json --purge --dry-run
python backend/scripts/interal_po_load.py --json po.json --purge --apply
```

The loader sends no e-mail, requests no approval, records no payment, creates no
receipt and moves no stock. Backup taken before the run:
`backups/pre_po_import_20260918.dump` (full, custom format, verified readable),
plus `backups/pre_po_import_20260918_potables.dump` for the three PO tables alone.
