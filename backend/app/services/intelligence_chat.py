"""
Maintenance Intelligence — Conversational Q&A (tool-use agent)
==============================================================
Answers natural-language questions about the platform's LIVE data by letting
Claude call read-only tools that reuse the existing KPI / report / dashboard /
findings logic. Every number in an answer is grounded in a real tool result —
the model is instructed never to invent data, and it never executes actions
(analysis only, consistent with the rest of the intelligence module).

Graceful degradation: if ANTHROPIC_API_KEY is unset, returns a clear message
instead of failing.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import select, func, text, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.plant_context import PlantContext
from app.core.plant_scope import plant_condition
from app.models.models import User, Equipment
from app.services.intelligence_calculator import build_findings

logger = logging.getLogger(__name__)

MODEL = "claude-opus-4-8"
MAX_TOKENS = 8000
MAX_TOOL_ROUNDS = 6
# Cap a single tool result so a huge payload can't blow the context window.
MAX_TOOL_RESULT_CHARS = 60_000


# ── Tool catalog (read-only) ────────────────────────────────────────────────

TOOLS = [
    {
        "name": "list_assets",
        "description": (
            "List the plant's equipment/machines with their LIVE operational status — the exact "
            "status the factory map shows right now (running | stopped | unjustified | planned_stop "
            "| intervention | maintenance | idle). Use it FIRST to map a machine name the user typed "
            "(e.g. 'IMA 4', 'IMA5', 'la STEFANI') to the real name/code/id, AND for any "
            "'right now' state question: how many machines are running / stopped / in maintenance, "
            "which machine is down, who operates it, WHICH TECHNICIAN is working on a machine. Returns "
            "per asset: id, name, code, asset_type (production|auxiliary), criticality, live status, "
            "current operator, open-ticket number, technicians actively working (name + since), and "
            "parent_machine for child assets (cobots/conveyors inherit the parent's status), plus "
            "status_summary (counts by status) and a status_legend."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "asset_type": {
                    "type": "string",
                    "enum": ["production", "auxiliary"],
                    "description": "Optional filter. Production = machines with MES/OEE; auxiliary = utilities (generator, compressor, HVAC…).",
                }
            },
            "required": [],
        },
    },
    {
        "name": "compare_machines",
        "description": (
            "Compare ALL production machines on key maintenance KPIs over a period. Returns, per "
            "machine: availability %, OEE %, downtime minutes, stops count, MTTR hours, MTBF hours, "
            "failures, total cost, backlog count, avg response minutes. Best for rankings and broad "
            "comparisons such as 'which machine has the best/worst availability', 'most failures', "
            "'highest downtime'."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_days": {"type": "integer", "description": "Lookback window in days (default 30, max 365)."}},
            "required": [],
        },
    },
    {
        "name": "machine_report",
        "description": (
            "Full KPI report for ONE machine over a period: availability, OEE, MTTR, MTBF, downtime "
            "with a Pareto of stop causes, costs by type, PM compliance, tickets and interventions. "
            "Use for deep dives, or to compare two specific machines (call once per machine). The "
            "'machine' argument accepts a name, code, or id — resolve names via list_assets first if unsure."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "machine": {"type": "string", "description": "Machine name, code, or id."},
                "period_days": {"type": "integer", "description": "Lookback window in days (default 30, max 365)."},
            },
            "required": ["machine"],
        },
    },
    {
        "name": "maintenance_overview",
        "description": (
            "Operational maintenance snapshot over a time window: open alerts, open/critical tickets, "
            "overdue alerts, average resolution time, tickets-by-machine (ranked), tickets-by-problem-type, "
            "tickets-by-technician, and tickets-by-status. Best for counts over a specific period such as "
            "'which machine broke down the most yesterday / last week', technician workload, and problem-type "
            "breakdowns. For a specific day like 'yesterday', set start_date and end_date both to that day."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "period_days": {"type": "integer", "description": "Rolling window in days (default 30). Ignored if start_date/end_date are given."},
                "start_date": {"type": "string", "description": "Window start, YYYY-MM-DD."},
                "end_date": {"type": "string", "description": "Window end (inclusive), YYYY-MM-DD."},
            },
            "required": [],
        },
    },
    {
        "name": "intelligence_findings",
        "description": (
            "Computed risk analysis: per-machine risk scores, top 'irritant' machines "
            "(downtime × frequency × MTTR), spare parts at risk of stockout, technician workload, and "
            "period-over-period trends. Best for risk, spare-parts and 'what should we worry about' questions."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_days": {"type": "integer", "description": "Lookback window in days (default 30, max 365)."}},
            "required": [],
        },
    },
    {
        "name": "purchasing_overview",
        "description": (
            "Procurement snapshot from purchase orders: total spend, PO count, TOP SUPPLIERS BY SPEND "
            "(ranked), and a breakdown by PO status — over a period. This is the fast, direct answer to "
            "'which supplier do we buy the most from', 'total purchasing spend', 'open POs'. Amounts are "
            "each PO's total_amount summed as stored (mostly CAD)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"period_days": {"type": "integer", "description": "Lookback window in days (default 365, max 3650)."}},
            "required": [],
        },
    },
    {
        "name": "inventory_overview",
        "description": (
            "Spare-parts inventory snapshot: total items, out-of-stock count, low-stock count, total stock "
            "value (quantity × best available unit cost), how many items actually have a cost, and a "
            "breakdown by category. Fast answer to 'how many parts are out of stock', 'inventory value', "
            "'stock by category'."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "describe_schema",
        "description": (
            "Map the database so you can write SQL for query_database. Call with NO argument to get "
            "the list of every table (with a short hint for the business ones). Then call again with "
            "`tables` set to the ones you need to get their exact columns and types. Use this for ANY "
            "question the maintenance-specific tools above don't cover — suppliers, purchase orders, "
            "inventory stock, costs/budgets, notifications, production, etc."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tables": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of table names to get detailed columns for. Omit to list all tables.",
                }
            },
            "required": [],
        },
    },
    {
        "name": "query_database",
        "description": (
            "Run ONE read-only SQL SELECT against the platform's PostgreSQL database and get the rows "
            "back. This is how you answer anything the other tools don't cover (e.g. 'which supplier do "
            "we buy the most from', stock value by category, cost breakdowns). Call describe_schema FIRST "
            "to get exact table and column names. Rules: SELECT/WITH only (no INSERT/UPDATE/DELETE/DDL — "
            "they are rejected and the DB is read-only); a single statement; results are capped (add your "
            "own LIMIT/GROUP BY/aggregates). Credential columns (passwords, tokens) are blocked. Prefer "
            "aggregates (SUM/COUNT/AVG + GROUP BY) over dumping raw rows. Every number you report must come "
            "from a real result."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "sql": {"type": "string", "description": "A single read-only SQL SELECT (PostgreSQL dialect)."},
            },
            "required": ["sql"],
        },
    },
]


# ── Read-only SQL access (schema introspection + guarded query) ───────────────

# Tables never exposed (credentials / auth plumbing).
_SENSITIVE_TABLES = {"password_reset_tokens", "user_invitations"}
# Column names never exposed / never queryable (hashes, tokens, secrets).
_SENSITIVE_COL = re.compile(r"(password|token|secret|api_key|_hash)", re.I)
# Statement keywords that must not appear (defence-in-depth on top of a READ ONLY txn).
_FORBIDDEN_SQL = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|copy|merge|vacuum|reindex|lock|call|do)\b",
    re.I,
)

# Short hints for the non-obvious business tables, surfaced by describe_schema so
# the model picks the right table without guessing.
_TABLE_HINTS = {
    "suppliers": "Supplier master (name, category, rating, lead_time_days, currency).",
    "supplier_orders": "Purchasing / procurement spend: one row per order (supplier_name, amount, currency, status, ordered_at). 'Supplier we buy most from' = SUM(amount) GROUP BY supplier.",
    "purchase_orders": "Purchase orders (procurement). See purchase_order_items for line items.",
    "purchase_order_items": "Purchase-order line items (part, quantity, unit price).",
    "stock_items": "Spare-parts inventory (quantity, min_quantity, unit_cost, average_cost, warehouse, location, category, supplier).",
    "inventory_movements": "Stock in/out movements (quantity, type, date).",
    "machines": "Production machines (MES/OEE); current_status is the LIVE state (running|stopped|maintenance|idle|planned_stop|unjustified|intervention). For 'status right now' questions prefer the list_assets tool — it adds the factory-map rules (open ticket → maintenance, parent inheritance).",
    "equipment": "Asset catalog (machines + auxiliaries); criticality, asset_type. Its status column is the STATIC catalog lifecycle, NOT the live state — use list_assets for live status.",
    "machine_stops": "Stop events with justification (started_at, duration_minutes, stop_category_id, comments, shift).",
    "machine_production_logs": "Per machine·shift·day production + OEE (actual_count, target_count, reject_count, availability_pct, performance_pct, quality_pct, oee_pct). FABRICATION machines only — assembly-line output is NOT here, it lives in job_order_runs.",
    "machine_production_hourly": "Per machine·hour produced counts (raw ADAM feed). Fabrication machines only — not assembly lines.",
    "machine_production_daily": "Daily produced/rejected per machine (TimescaleDB rollup view of machine_production_hourly). Fabrication machines only — not assembly lines.",
    "job_orders": "Manufacturing orders (OF): number, product, quantity, status, dates. WIP = OFs with an open run in job_order_runs.",
    "job_order_runs": "THE production ledger for ASSEMBLY LINES ('Ligne d'assemblage', rembourrage, coussins) and OF tracking: one row per OF×machine run with pieces (units produced during the run), rejects, started_at/ended_at (NULL ended_at = OF is on that machine now), last_piece_at. Assembly-line production by line/day = SUM(pieces) GROUP BY machine_id (join machines for the name), filtered on started_at or last_piece_at.",
    "maintenance_tickets": "Breakdown/maintenance tickets (status, priority, machine_id, times, technician).",
    "maintenance_alerts": "Operator-raised alerts on machines.",
    "work_orders": "Work orders (type corrective/preventive/improvement, status, costs, downtime, dates).",
    "wo_costs": "Work-order cost lines. labor_records = labor time; wo_parts = parts used.",
    "technicians": "Maintenance technicians (specialty, shift).",
    "cost_center_budgets": "Budgets per cost center (kind = opex/capex).",
    "sap_cost_lines": "Official OPEX actuals imported from SAP GL (fiscal Dec–Nov).",
    "notification_logs": "Sent notifications (SMS/email/Teams) with type, recipient, status.",
}


def _schema_catalog(tables: Optional[list[str]] = None) -> dict:
    """Table→columns map from SQLAlchemy metadata, minus sensitive tables/columns.
    With no `tables`, returns just the table names (+ hints). With `tables`, returns
    the columns (name + type) for those tables."""
    from app.db.base import Base

    all_tables = {n: t for n, t in Base.metadata.tables.items() if n not in _SENSITIVE_TABLES}
    # A TimescaleDB continuous aggregate — a real, queryable view not in the ORM metadata.
    extra_views = {
        "machine_production_daily": ["machine_id UUID", "bucket TIMESTAMPTZ (day)", "produced BIGINT", "rejected BIGINT"],
    }

    if not tables:
        names = sorted(list(all_tables.keys()) + list(extra_views.keys()))
        return {
            "tables": {n: _TABLE_HINTS.get(n, "") for n in names},
            "note": "Call describe_schema again with `tables` set to the ones you need for their columns.",
        }

    out: dict[str, Any] = {}
    for name in tables:
        if name in extra_views:
            out[name] = {"columns": extra_views[name], "hint": _TABLE_HINTS.get(name, "")}
        elif name in all_tables:
            cols = [f"{c.name} {c.type}" for c in all_tables[name].columns if not _SENSITIVE_COL.search(c.name)]
            out[name] = {"columns": cols, "hint": _TABLE_HINTS.get(name, "")}
        else:
            out[name] = {"error": "unknown or restricted table"}
    return out


def _validate_sql(sql: str) -> tuple[str, Optional[str]]:
    """Return (safe_sql, error). Enforces a single read-only SELECT/WITH, blocks
    credential columns and any write/DDL keyword, and appends a LIMIT if missing."""
    s = (sql or "").strip().rstrip(";").strip()
    if not s:
        return "", "Empty query."
    low = s.lower()
    if not (low.startswith("select") or low.startswith("with")):
        return "", "Only read-only SELECT/WITH queries are allowed."
    if ";" in s:
        return "", "Only a single statement is allowed (no ';')."
    if _SENSITIVE_COL.search(s):
        return "", "Query references restricted credential fields (passwords/tokens) and was blocked."
    if _FORBIDDEN_SQL.search(s):
        return "", "Only read-only SELECT queries are allowed — no INSERT/UPDATE/DELETE/DDL."
    if not re.search(r"\blimit\b", low):
        s = f"{s}\nLIMIT 500"
    return s, None


async def _query_database(sql: str, plant_ids_csv: Optional[str] = None,
                          grouped_ids_csv: Optional[str] = None) -> dict:
    """Execute a validated read-only SELECT in a READ ONLY transaction with a
    statement timeout, and return the rows.

    Plant isolation: for non-corporate callers, `plant_ids_csv` (the user's
    allowed plant ids) is installed as the `app.plant_ids` GUC for this
    transaction — the row-level-security policies then hide every other
    plant's rows from the arbitrary SQL. Corporate callers query unscoped."""
    from app.db.session import engine

    safe, err = _validate_sql(sql)
    if err:
        return {"error": err}
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET TRANSACTION READ ONLY"))
            await conn.execute(text("SET LOCAL statement_timeout = 8000"))
            if plant_ids_csv:
                await conn.execute(
                    text("SELECT set_config('app.plant_ids', :ids, true)"),
                    {"ids": plant_ids_csv},
                )
                await conn.execute(
                    text("SELECT set_config('app.plant_ids_grouped', :ids, true)"),
                    {"ids": grouped_ids_csv or plant_ids_csv},
                )
            # The app's own login is the bootstrap superuser, which BYPASSES
            # row-level security — drop to the read-only ninja role for the
            # rest of the transaction so the plant policies actually apply.
            await conn.execute(text("SET LOCAL ROLE kaizo_ninja"))
            res = await conn.execute(text(safe))
            rows = [dict(r) for r in res.mappings().all()]
            await conn.rollback()
    except Exception as exc:  # surface to the model, don't crash the turn
        return {"error": f"Query failed: {exc}", "sql": safe}
    return {"sql": safe, "row_count": len(rows), "rows": rows[:1000]}


def _clamp(value: Any, default: int, hi: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, min(v, hi))


def _system_prompt(language: str = "en", mode: str = "text") -> str:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    # The platform ships only EN/FR/ES — answer in the user's selected language,
    # regardless of the language they happened to type the question in.
    lang_instructions = {
        "en": "Always answer in English.",
        "fr": "Réponds toujours en français, dans un langage professionnel et naturel.",
        "es": "Responde siempre en español, con un lenguaje profesional y natural.",
    }
    lang_note = lang_instructions.get((language or "en")[:2], lang_instructions["en"])
    return f"""You are the data-intelligence assistant for an industrial plant (Foliot Furniture).
You can answer questions about ANY data in the platform: maintenance (machines, KPIs — availability, OEE,
MTTR, MTBF, downtime — tickets, work orders, stops, technicians), plus spare-parts inventory, suppliers,
purchasing / purchase orders, maintenance costs and budgets, production output, notifications, and more.

Today's date is {today} (UTC). Resolve relative dates ("yesterday", "last week", "this month") against it.

How to work:
- ALWAYS ground every number in a tool result. Call tools to fetch real data — never invent or estimate values.
- Pick the tool by topic:
  • Maintenance KPIs and risk have fast, purpose-built tools — PREFER them:
    - Live machine state RIGHT NOW ("how many machines are running / stopped now", "which machine is
      down", current operator, "who is the technician working on X") → list_assets: its `status` is the
      live factory-map status (running | stopped | unjustified | planned_stop | intervention |
      maintenance | idle), `technicians` names who is actively working (purple assets), and
      `status_summary` has the counts. "In maintenance" questions cover BOTH maintenance (amber) and
      intervention (purple) statuses; cobots/conveyors inherit their parent_machine's status and the
      ticket/technicians live on the parent. NEVER answer "now" state questions from equipment.status
      in SQL — that column is the static catalog, not the live state.
    - Rankings / "best/worst" across machines → compare_machines.
    - One or two specific machines (deep dive) → machine_report (map names via list_assets first).
    - Counts over a specific window (e.g. "yesterday") → maintenance_overview with start_date/end_date.
    - Risk / spare-parts-at-risk / "what should we worry about" → intelligence_findings.
  • Purchasing ("which supplier do we buy most from", total spend, open POs) → purchasing_overview.
  • Inventory status ("how many parts out of stock", stock value, by category) → inventory_overview.
  • PRODUCTION OUTPUT — two different sources, pick by machine type:
    - Fabrication machines (IMA, SCM, Homag…) → machine_production_logs / machine_production_daily via SQL.
    - ASSEMBLY LINES ("ligne d'assemblage", ASM, rembourrage, coussins) → SUM(job_order_runs.pieces)
      via SQL — assembly output NEVER appears in machine_production_*; a zero there does not mean zero production.
  • ANYTHING ELSE — cost or budget breakdowns, notifications, supplier/part details,
    or any ad-hoc cross-domain question — use the database directly:
    call describe_schema (no args) to see the tables, then describe_schema(tables=[...]) for their columns,
    then query_database with a read-only SQL SELECT (use SUM/COUNT/AVG + GROUP BY; add LIMIT).
- You may call several tools before answering. If a tool returns an error or empty data, say so plainly.
- Never claim you lack access to a topic before checking describe_schema — the database covers the whole platform.

Style:
- {lang_note}
- Be concise and direct. Lead with the answer, then a few supporting numbers. Use short bullet lists ("- ") when comparing.
- Keep machine names, codes and ticket numbers verbatim — never translate them.
- State the period you used (e.g. "over the last 30 days"). If data is missing or insufficient, say "insufficient data" rather than guessing.
- You only analyze and report. You never create, modify, or delete anything.""" + (
        """

VOICE CONVERSATION MODE — your answer is READ ALOUD by text-to-speech in a live, hands-free conversation:
- Answer in ONE to THREE short sentences. Lead with the direct answer and only the one to three numbers that matter most.
- Plain spoken prose ONLY: no markdown, no bullet points, no headers, no tables, no code. It must sound natural said out loud.
- Round numbers the way people speak them (say "about 87 percent", not "87.34%"). Keep machine names and codes verbatim.
- If meaningfully more depth exists (rankings, breakdowns, causes, history), END with a very short offer to go deeper, in the user's language (e.g. "Veux-tu les détails ?").
- When the user asks for more detail, expand — still spoken style, at most ~6 sentences, and offer to continue if there is even more.
- Prefer the FEWEST tool calls that answer the question — response speed matters in a live conversation."""
        if mode == "voice" else ""
    )


# ── Tool resolution + execution ──────────────────────────────────────────────

async def _resolve_equipment_id(db: AsyncSession, raw: str, ctx: PlantContext) -> Optional[UUID]:
    """Map a name / code / id string to an Equipment id (active plant only)."""
    s = (raw or "").strip()
    if not s:
        return None
    try:
        u = UUID(s)
        eq = await db.get(Equipment, u)
        if eq and ctx.can_access(eq.plant_id):
            return eq.id
    except ValueError:
        pass

    rows = (await db.execute(
        select(Equipment).where(Equipment.active == True, plant_condition(Equipment, ctx))  # noqa: E712
    )).scalars().all()
    sl = s.lower()
    # exact name / code
    for e in rows:
        if (e.name or "").lower() == sl or (e.code or "").lower() == sl:
            return e.id
    # alphanumeric-normalized (e.g. "IMA 04" ~ "IMA04")
    def norm(x: Optional[str]) -> str:
        return "".join(ch for ch in (x or "").lower() if ch.isalnum())
    ns = norm(s)
    if ns:
        for e in rows:
            if norm(e.name) == ns or norm(e.code) == ns:
                return e.id
    # partial contains
    for e in rows:
        if sl in (e.name or "").lower() or sl in (e.code or "").lower():
            return e.id
    return None


async def _list_assets(db: AsyncSession, asset_type: Optional[str], ctx: PlantContext) -> dict:
    # Live (factory-map) status, not the static equipment.status catalog column —
    # same single source of truth the map uses, so the two never disagree.
    from app.services.live_status import live_details_by_equipment

    q = select(Equipment).where(Equipment.active == True, plant_condition(Equipment, ctx))  # noqa: E712
    if asset_type in ("production", "auxiliary"):
        q = q.where(func.coalesce(Equipment.asset_type, "production") == asset_type)
    rows = (await db.execute(q.order_by(Equipment.name))).scalars().all()
    live = await live_details_by_equipment(db, rows)

    # Parent names so child assets (cobots/conveyors) can say whose status they
    # inherit — the ticket/technicians always live on the parent machine.
    name_by_id = {e.id: e.name for e in rows}
    missing_parents = {e.parent_equipment_id for e in rows
                       if e.parent_equipment_id and e.parent_equipment_id not in name_by_id}
    if missing_parents:
        for pe in (await db.execute(select(Equipment).where(Equipment.id.in_(missing_parents)))).scalars().all():
            name_by_id[pe.id] = pe.name

    assets = []
    summary: dict[str, int] = {}
    for e in rows:
        la = live.get(str(e.id))
        status = la.status if la else (e.status.value if hasattr(e.status, "value") else str(e.status))
        summary[status] = summary.get(status, 0) + 1
        assets.append({
            "id": str(e.id),
            "name": e.name,
            "code": e.code,
            "asset_type": e.asset_type or "production",
            "criticality": e.criticality,
            "status": status,
            "operator": la.operator if la else None,
            "open_ticket": (la.open_ticket or {}).get("number") if la else None,
            "technicians": (la.technicians or None) if la else None,
            "parent_machine": name_by_id.get(e.parent_equipment_id) if e.parent_equipment_id else None,
        })
    return {
        "count": len(assets),
        "status_summary": summary,
        "status_legend": {
            "running": "producing normally (green on the factory map)",
            "stopped": "unplanned stop, reason entered (red)",
            "unjustified": "stopped, no reason entered yet (pink)",
            "planned_stop": "scheduled/planned stop (blue)",
            "intervention": "technician actively working on it (purple) — `technicians` says who and since when",
            "maintenance": "in maintenance or open maintenance call (amber)",
            "idle": "idle / not in production (gray)",
        },
        "notes": (
            "Assets with a parent_machine (cobots, conveyors) INHERIT the parent's status — the open "
            "ticket and technicians are recorded on the parent machine, not on the child. When the user "
            "asks what is 'in maintenance' / 'being repaired', include BOTH maintenance (amber) and "
            "intervention (purple = maintenance actively happening) assets."
        ),
        "assets": assets,
    }


async def _machine_report(db: AsyncSession, ctx: PlantContext, machine: str, period_days: int) -> dict:
    from app.api.routes.reports import machine_report  # lazy import avoids cycles

    eq_id = await _resolve_equipment_id(db, machine, ctx)
    if not eq_id:
        return {"error": f"No machine matched '{machine}'. Call list_assets to see valid names."}
    data = await machine_report(machine_id=eq_id, period_days=period_days, db=db, ctx=ctx)
    # Trim verbose daily-trend arrays; keep the headline numbers + top stop causes.
    if isinstance(data.get("availability"), dict):
        data["availability"].pop("trend", None)
    if isinstance(data.get("oee"), dict):
        data["oee"].pop("trend", None)
    dt = data.get("downtime")
    if isinstance(dt, dict) and isinstance(dt.get("pareto"), list):
        dt["pareto"] = dt["pareto"][:6]
    return data


async def _purchasing_overview(db: AsyncSession, period_days: int, ctx: PlantContext) -> dict:
    """Spend + PO counts, ranked by supplier, over a window (from purchase_orders)."""
    from datetime import date, timedelta
    from app.models.models import PurchaseOrder, Supplier

    since = date.today() - timedelta(days=period_days)
    spend = func.coalesce(func.sum(PurchaseOrder.total_amount), 0.0)

    by_supplier_rows = (await db.execute(
        select(Supplier.name, func.count(PurchaseOrder.id), spend)
        .join(PurchaseOrder, PurchaseOrder.supplier_id == Supplier.id)
        .where(PurchaseOrder.order_date >= since, plant_condition(PurchaseOrder, ctx))
        .group_by(Supplier.name)
        .order_by(spend.desc())
    )).all()
    by_supplier = [{"supplier": r[0], "orders": r[1], "spend": round(r[2] or 0.0, 2)} for r in by_supplier_rows]

    by_status_rows = (await db.execute(
        select(PurchaseOrder.status, func.count(), spend)
        .where(PurchaseOrder.order_date >= since, plant_condition(PurchaseOrder, ctx))
        .group_by(PurchaseOrder.status)
    )).all()
    by_status = [
        {"status": r[0].value if hasattr(r[0], "value") else str(r[0]), "count": r[1], "spend": round(r[2] or 0.0, 2)}
        for r in by_status_rows
    ]

    return {
        "period_days": period_days,
        "total_purchase_orders": sum(s["orders"] for s in by_supplier),
        "total_spend": round(sum(s["spend"] for s in by_supplier), 2),
        "amount_note": "PO total_amount summed as stored (mostly CAD); mixed currencies not converted.",
        "top_suppliers_by_spend": by_supplier[:20],
        "by_status": by_status,
    }


async def _inventory_overview(db: AsyncSession, ctx: PlantContext) -> dict:
    """Stock counts, value, and category breakdown from stock_items (group pool)."""
    from app.models.models import StockItem

    scope = plant_condition(StockItem, ctx)   # group-scoped: QC shared warehouse
    unit_cost = func.coalesce(StockItem.average_cost, StockItem.unit_cost, StockItem.last_purchase_cost)
    low_cond = or_(
        StockItem.quantity <= 0,
        and_(StockItem.min_quantity.isnot(None), StockItem.quantity <= StockItem.min_quantity),
    )

    total = (await db.execute(select(func.count()).select_from(StockItem).where(scope))).scalar_one()
    zero = (await db.execute(select(func.count()).select_from(StockItem).where(scope, StockItem.quantity <= 0))).scalar_one()
    low = (await db.execute(select(func.count()).select_from(StockItem).where(scope, low_cond))).scalar_one()
    value = (await db.execute(
        select(func.coalesce(func.sum(StockItem.quantity * unit_cost), 0.0)).where(scope, unit_cost.isnot(None))
    )).scalar_one()
    priced = (await db.execute(select(func.count()).select_from(StockItem).where(scope, unit_cost.isnot(None)))).scalar_one()
    cats = (await db.execute(
        select(StockItem.category, func.count())
        .where(scope, StockItem.category.isnot(None))
        .group_by(StockItem.category).order_by(func.count().desc()).limit(15)
    )).all()

    return {
        "total_items": total,
        "zero_stock_count": zero,
        "low_stock_count": low,
        "total_stock_value": round(value or 0.0, 2),
        "items_with_cost": priced,
        "value_note": "value = quantity × COALESCE(average_cost, unit_cost, last_purchase_cost); items without any cost are excluded.",
        "by_category": [{"category": r[0], "count": r[1]} for r in cats],
    }


async def _run_tool(db: AsyncSession, user: User, ctx: PlantContext, name: str, args: dict) -> Any:
    # Every tool answers within the caller's plant context: curated tools carry
    # explicit filters; raw SQL is fenced by RLS via the app.plant_ids GUC.
    plant_ids_csv = None if ctx.is_corporate else ",".join(
        sorted(str(p) for p in ctx.allowed_plant_ids)
    )
    grouped_ids_csv = None if ctx.is_corporate else ",".join(
        sorted(str(p) for p in ctx.allowed_group_plant_ids)
    )
    try:
        if name == "list_assets":
            return await _list_assets(db, args.get("asset_type"), ctx)

        if name == "compare_machines":
            from app.api.routes.reports import compare_machines
            return await compare_machines(period_days=_clamp(args.get("period_days"), 30, 365), db=db, ctx=ctx)

        if name == "machine_report":
            return await _machine_report(db, ctx, args.get("machine", ""), _clamp(args.get("period_days"), 30, 365))

        if name == "maintenance_overview":
            from app.api.routes.maintenance_dashboard import maintenance_dashboard
            data = await maintenance_dashboard(
                period_days=_clamp(args.get("period_days"), 30, 730),
                start_date=args.get("start_date"),
                end_date=args.get("end_date"),
                machine_ids=None,
                db=db,
                ctx=ctx,
            )
            data.pop("trend", None)  # drop the long daily series
            return data

        if name == "intelligence_findings":
            return await build_findings(
                db, period_days=_clamp(args.get("period_days"), 30, 365),
                plant_id=None if ctx.is_corporate else str(ctx.plant_id),
            )

        if name == "purchasing_overview":
            return await _purchasing_overview(db, _clamp(args.get("period_days"), 365, 3650), ctx)

        if name == "inventory_overview":
            return await _inventory_overview(db, ctx)

        if name == "describe_schema":
            return _schema_catalog(args.get("tables"))

        if name == "query_database":
            return await _query_database(args.get("sql", ""), plant_ids_csv, grouped_ids_csv)

        return {"error": f"Unknown tool '{name}'."}
    except Exception as exc:  # surface tool failures to the model, don't crash the turn
        logger.exception("intelligence chat tool '%s' failed", name)
        # A DB error leaves the shared session's transaction in a failed state;
        # without a rollback every later tool call in this conversation dies on
        # PendingRollbackError. Best-effort — harmless for non-DB failures.
        try:
            await db.rollback()
        except Exception:
            pass
        return {"error": f"Tool '{name}' failed: {exc}"}


# ── Agentic loop ──────────────────────────────────────────────────────────────

def _sse(event: str, data: dict) -> str:
    """One Server-Sent-Events frame (single-line JSON payload)."""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def answer_question_stream(
    current_user: User,
    messages: list[dict],
    ctx: PlantContext,
    language: str = "en",
    mode: str = "text",
):
    """SSE generator variant of answer_question. Same tool-use loop, but the
    final answer's text is pushed to the client as it is generated.

    Events:
      status {"phase": "thinking"|"answering"}  — model state, for a live chip
      tool   {"name": ...}                      — a tool call started
      delta  {"text": ...}                      — text tokens of the CURRENT turn
      round  {}                                 — turn ended in tool_use: text
                                                  streamed so far was preliminary
                                                  and must be discarded
      done   {"answer", "used_tools", "ai_generated"} — authoritative final result
      error  {"detail": ...}

    Opens its own DB session: FastAPI (>=0.106) closes Depends(get_db) sessions
    BEFORE a StreamingResponse body starts iterating, so a dependency-injected
    session would already be closed by the time tools run here."""
    if not settings.anthropic_api_key:
        yield _sse("done", {
            "answer": "The AI assistant is not configured (no API key). Ask an administrator to set ANTHROPIC_API_KEY.",
            "used_tools": [], "ai_generated": False,
        })
        return

    try:
        from anthropic import AsyncAnthropic
    except Exception:
        logger.error("anthropic SDK not installed")
        yield _sse("done", {"answer": "The AI library is not installed on the server.", "used_tools": [], "ai_generated": False})
        return

    convo: list[dict] = [
        {"role": m["role"], "content": m["content"]}
        for m in messages
        if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
    ]
    if not convo or convo[0]["role"] != "user":
        yield _sse("done", {"answer": "Ask a question to get started.", "used_tools": [], "ai_generated": False})
        return

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    system = _system_prompt(language, mode)
    used: list[str] = []

    # Producer/consumer split: the agent loop pushes frames into a queue and the
    # generator drains it with a timeout, emitting an SSE comment ping during
    # dead air (long thinking blocks, slow tools). Without it, intermediaries
    # with idle timeouts (cloudflared ~100s, strict proxies) cut the stream
    # mid-question and the client falls back — doubling the wait.
    queue: asyncio.Queue = asyncio.Queue()
    end_of_stream = object()

    async def produce() -> None:
        emit = queue.put
        try:
            from app.db.session import AsyncSessionLocal

            async with AsyncSessionLocal() as db:
                for _ in range(MAX_TOOL_ROUNDS):
                    async with client.messages.stream(
                        model=MODEL,
                        max_tokens=MAX_TOKENS,
                        thinking={"type": "adaptive"},
                        system=system,
                        tools=TOOLS,
                        messages=convo,
                    ) as stream:
                        async for event in stream:
                            etype = getattr(event, "type", "")
                            if etype == "content_block_start":
                                block = getattr(event, "content_block", None)
                                btype = getattr(block, "type", "")
                                if btype == "thinking":
                                    await emit(_sse("status", {"phase": "thinking"}))
                                elif btype == "tool_use":
                                    # Display event only — `used` is appended at
                                    # execution time (parity with answer_question):
                                    # a max_tokens-truncated block never runs.
                                    await emit(_sse("tool", {"name": block.name}))
                                elif btype == "text":
                                    await emit(_sse("status", {"phase": "answering"}))
                            elif etype == "content_block_delta":
                                delta = getattr(event, "delta", None)
                                if getattr(delta, "type", "") == "text_delta" and delta.text:
                                    await emit(_sse("delta", {"text": delta.text}))
                        resp = await stream.get_final_message()

                    if resp.stop_reason == "tool_use":
                        # Whatever text streamed this turn was pre-tool commentary,
                        # not the answer — tell the client to void it.
                        await emit(_sse("round", {}))
                        convo.append({"role": "assistant", "content": resp.content})
                        results = []
                        for block in resp.content:
                            if getattr(block, "type", None) == "tool_use":
                                used.append(block.name)
                                out = await _run_tool(db, current_user, ctx, block.name, dict(block.input or {}))
                                payload = json.dumps(out, default=str)
                                if len(payload) > MAX_TOOL_RESULT_CHARS:
                                    payload = payload[:MAX_TOOL_RESULT_CHARS] + ' …", "_truncated": true}'
                                results.append({"type": "tool_result", "tool_use_id": block.id, "content": payload})
                        convo.append({"role": "user", "content": results})
                        continue

                    answer = "\n".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
                    await emit(_sse("done", {
                        "answer": answer or "I couldn't produce an answer for that.",
                        "used_tools": sorted(set(used)),
                        "ai_generated": True,
                    }))
                    return

                await emit(_sse("done", {
                    "answer": "I gathered a lot of data but couldn't finish — try a more specific question.",
                    "used_tools": sorted(set(used)),
                    "ai_generated": True,
                }))
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("intelligence chat stream failed")
            await emit(_sse("error", {"detail": f"The assistant hit an error: {exc}"}))
        finally:
            await queue.put(end_of_stream)

    task = asyncio.create_task(produce())
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=10)
            except asyncio.TimeoutError:
                # Dead air (long thinking / slow tool) — keep the pipe warm.
                yield ": ping\n\n"
                continue
            if item is end_of_stream:
                break
            yield item
    finally:
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass
        try:
            await client.close()
        except Exception:
            pass


async def answer_question(
    db: AsyncSession,
    current_user: User,
    messages: list[dict],
    ctx: PlantContext,
    language: str = "en",
    mode: str = "text",
) -> dict:
    """Run the tool-use loop and return {answer, used_tools, ai_generated}."""
    if not settings.anthropic_api_key:
        return {
            "answer": "The AI assistant is not configured (no API key). Ask an administrator to set ANTHROPIC_API_KEY.",
            "used_tools": [],
            "ai_generated": False,
        }

    try:
        from anthropic import AsyncAnthropic
    except Exception:
        logger.error("anthropic SDK not installed")
        return {"answer": "The AI library is not installed on the server.", "used_tools": [], "ai_generated": False}

    convo: list[dict] = [
        {"role": m["role"], "content": m["content"]}
        for m in messages
        if m.get("role") in ("user", "assistant") and (m.get("content") or "").strip()
    ]
    if not convo or convo[0]["role"] != "user":
        return {"answer": "Ask a question to get started.", "used_tools": [], "ai_generated": False}

    client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    system = _system_prompt(language, mode)
    used: list[str] = []

    try:
        for _ in range(MAX_TOOL_ROUNDS):
            resp = await client.messages.create(
                model=MODEL,
                max_tokens=MAX_TOKENS,
                thinking={"type": "adaptive"},
                system=system,
                tools=TOOLS,
                messages=convo,
            )

            if resp.stop_reason == "tool_use":
                # Echo the assistant turn (incl. thinking + tool_use blocks) back verbatim.
                convo.append({"role": "assistant", "content": resp.content})
                results = []
                for block in resp.content:
                    if getattr(block, "type", None) == "tool_use":
                        used.append(block.name)
                        out = await _run_tool(db, current_user, ctx, block.name, dict(block.input or {}))
                        payload = json.dumps(out, default=str)
                        if len(payload) > MAX_TOOL_RESULT_CHARS:
                            payload = payload[:MAX_TOOL_RESULT_CHARS] + ' …", "_truncated": true}'
                        results.append({"type": "tool_result", "tool_use_id": block.id, "content": payload})
                convo.append({"role": "user", "content": results})
                continue

            # Final answer
            answer = "\n".join(b.text for b in resp.content if getattr(b, "type", None) == "text").strip()
            return {
                "answer": answer or "I couldn't produce an answer for that.",
                "used_tools": sorted(set(used)),
                "ai_generated": True,
            }

        return {
            "answer": "I gathered a lot of data but couldn't finish — try a more specific question.",
            "used_tools": sorted(set(used)),
            "ai_generated": True,
        }
    except Exception as exc:
        logger.exception("intelligence chat failed")
        return {"answer": f"The assistant hit an error: {exc}", "used_tools": sorted(set(used)), "ai_generated": False}
    finally:
        try:
            await client.close()
        except Exception:
            pass
