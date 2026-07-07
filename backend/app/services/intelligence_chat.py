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

import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import select, func, text, or_, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
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
            "List the plant's equipment/machines (the catalog). Call this FIRST to map a "
            "machine name the user typed (e.g. 'IMA 4', 'IMA5', 'la STEFANI') to the real "
            "name/code/id, and to know which assets actually exist. Returns id, name, code, "
            "asset_type (production|auxiliary), criticality and status."
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
    "machines": "Production machines (MES/OEE); current_status, shifts_config, target_count.",
    "equipment": "Asset catalog (machines + auxiliaries); criticality, status, asset_type.",
    "machine_stops": "Stop events with justification (started_at, duration_minutes, stop_category_id, comments, shift).",
    "machine_production_logs": "Per machine·shift·day production + OEE (actual_count, target_count, reject_count, availability_pct, performance_pct, quality_pct, oee_pct).",
    "machine_production_hourly": "Per machine·hour produced counts (raw ADAM feed).",
    "machine_production_daily": "Daily produced/rejected per machine (TimescaleDB rollup view of machine_production_hourly).",
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


async def _query_database(sql: str) -> dict:
    """Execute a validated read-only SELECT in a READ ONLY transaction with a
    statement timeout, and return the rows."""
    from app.db.session import engine

    safe, err = _validate_sql(sql)
    if err:
        return {"error": err}
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET TRANSACTION READ ONLY"))
            await conn.execute(text("SET LOCAL statement_timeout = 8000"))
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


def _system_prompt(language: str = "en") -> str:
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
    - Rankings / "best/worst" across machines → compare_machines.
    - One or two specific machines (deep dive) → machine_report (map names via list_assets first).
    - Counts over a specific window (e.g. "yesterday") → maintenance_overview with start_date/end_date.
    - Risk / spare-parts-at-risk / "what should we worry about" → intelligence_findings.
  • Purchasing ("which supplier do we buy most from", total spend, open POs) → purchasing_overview.
  • Inventory status ("how many parts out of stock", stock value, by category) → inventory_overview.
  • ANYTHING ELSE — cost or budget breakdowns, production totals, notifications, supplier/part details,
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
- You only analyze and report. You never create, modify, or delete anything."""


# ── Tool resolution + execution ──────────────────────────────────────────────

async def _resolve_equipment_id(db: AsyncSession, raw: str) -> Optional[UUID]:
    """Map a name / code / id string to an Equipment id."""
    s = (raw or "").strip()
    if not s:
        return None
    try:
        u = UUID(s)
        eq = await db.get(Equipment, u)
        if eq:
            return eq.id
    except ValueError:
        pass

    rows = (await db.execute(select(Equipment).where(Equipment.active == True))).scalars().all()  # noqa: E712
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


async def _list_assets(db: AsyncSession, asset_type: Optional[str]) -> dict:
    q = select(Equipment).where(Equipment.active == True)  # noqa: E712
    if asset_type in ("production", "auxiliary"):
        q = q.where(func.coalesce(Equipment.asset_type, "production") == asset_type)
    rows = (await db.execute(q.order_by(Equipment.name))).scalars().all()
    return {
        "count": len(rows),
        "assets": [
            {
                "id": str(e.id),
                "name": e.name,
                "code": e.code,
                "asset_type": e.asset_type or "production",
                "criticality": e.criticality,
                "status": e.status.value if hasattr(e.status, "value") else str(e.status),
            }
            for e in rows
        ],
    }


async def _machine_report(db: AsyncSession, user: User, machine: str, period_days: int) -> dict:
    from app.api.routes.reports import machine_report  # lazy import avoids cycles

    eq_id = await _resolve_equipment_id(db, machine)
    if not eq_id:
        return {"error": f"No machine matched '{machine}'. Call list_assets to see valid names."}
    data = await machine_report(machine_id=eq_id, period_days=period_days, db=db, current_user=user)
    # Trim verbose daily-trend arrays; keep the headline numbers + top stop causes.
    if isinstance(data.get("availability"), dict):
        data["availability"].pop("trend", None)
    if isinstance(data.get("oee"), dict):
        data["oee"].pop("trend", None)
    dt = data.get("downtime")
    if isinstance(dt, dict) and isinstance(dt.get("pareto"), list):
        dt["pareto"] = dt["pareto"][:6]
    return data


async def _purchasing_overview(db: AsyncSession, period_days: int) -> dict:
    """Spend + PO counts, ranked by supplier, over a window (from purchase_orders)."""
    from datetime import date, timedelta
    from app.models.models import PurchaseOrder, Supplier

    since = date.today() - timedelta(days=period_days)
    spend = func.coalesce(func.sum(PurchaseOrder.total_amount), 0.0)

    by_supplier_rows = (await db.execute(
        select(Supplier.name, func.count(PurchaseOrder.id), spend)
        .join(PurchaseOrder, PurchaseOrder.supplier_id == Supplier.id)
        .where(PurchaseOrder.order_date >= since)
        .group_by(Supplier.name)
        .order_by(spend.desc())
    )).all()
    by_supplier = [{"supplier": r[0], "orders": r[1], "spend": round(r[2] or 0.0, 2)} for r in by_supplier_rows]

    by_status_rows = (await db.execute(
        select(PurchaseOrder.status, func.count(), spend)
        .where(PurchaseOrder.order_date >= since)
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


async def _inventory_overview(db: AsyncSession) -> dict:
    """Stock counts, value, and category breakdown from stock_items."""
    from app.models.models import StockItem

    unit_cost = func.coalesce(StockItem.average_cost, StockItem.unit_cost, StockItem.last_purchase_cost)
    low_cond = or_(
        StockItem.quantity <= 0,
        and_(StockItem.min_quantity.isnot(None), StockItem.quantity <= StockItem.min_quantity),
    )

    total = (await db.execute(select(func.count()).select_from(StockItem))).scalar_one()
    zero = (await db.execute(select(func.count()).select_from(StockItem).where(StockItem.quantity <= 0))).scalar_one()
    low = (await db.execute(select(func.count()).select_from(StockItem).where(low_cond))).scalar_one()
    value = (await db.execute(
        select(func.coalesce(func.sum(StockItem.quantity * unit_cost), 0.0)).where(unit_cost.isnot(None))
    )).scalar_one()
    priced = (await db.execute(select(func.count()).select_from(StockItem).where(unit_cost.isnot(None)))).scalar_one()
    cats = (await db.execute(
        select(StockItem.category, func.count())
        .where(StockItem.category.isnot(None))
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


async def _run_tool(db: AsyncSession, user: User, name: str, args: dict) -> Any:
    try:
        if name == "list_assets":
            return await _list_assets(db, args.get("asset_type"))

        if name == "compare_machines":
            from app.api.routes.reports import compare_machines
            return await compare_machines(period_days=_clamp(args.get("period_days"), 30, 365), db=db, current_user=user)

        if name == "machine_report":
            return await _machine_report(db, user, args.get("machine", ""), _clamp(args.get("period_days"), 30, 365))

        if name == "maintenance_overview":
            from app.api.routes.maintenance_dashboard import maintenance_dashboard
            data = await maintenance_dashboard(
                period_days=_clamp(args.get("period_days"), 30, 730),
                start_date=args.get("start_date"),
                end_date=args.get("end_date"),
                machine_ids=None,
                db=db,
                current_user=user,
            )
            data.pop("trend", None)  # drop the long daily series
            return data

        if name == "intelligence_findings":
            return await build_findings(db, period_days=_clamp(args.get("period_days"), 30, 365))

        if name == "purchasing_overview":
            return await _purchasing_overview(db, _clamp(args.get("period_days"), 365, 3650))

        if name == "inventory_overview":
            return await _inventory_overview(db)

        if name == "describe_schema":
            return _schema_catalog(args.get("tables"))

        if name == "query_database":
            return await _query_database(args.get("sql", ""))

        return {"error": f"Unknown tool '{name}'."}
    except Exception as exc:  # surface tool failures to the model, don't crash the turn
        logger.exception("intelligence chat tool '%s' failed", name)
        return {"error": f"Tool '{name}' failed: {exc}"}


# ── Agentic loop ──────────────────────────────────────────────────────────────

async def answer_question(
    db: AsyncSession,
    current_user: User,
    messages: list[dict],
    language: str = "en",
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
    system = _system_prompt(language)
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
                        out = await _run_tool(db, current_user, block.name, dict(block.input or {}))
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
