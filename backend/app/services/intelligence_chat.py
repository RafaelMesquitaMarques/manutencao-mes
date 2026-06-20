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
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import select, func
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
]


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
    return f"""You are the Maintenance Intelligence assistant for an industrial plant (Foliot Furniture).
You answer questions about the plant's maintenance data — machines, KPIs (availability, OEE, MTTR, MTBF,
downtime), tickets, work orders, stops, technicians, spare parts and costs.

Today's date is {today} (UTC). Resolve relative dates ("yesterday", "last week", "this month") against it.

How to work:
- ALWAYS ground every number in a tool result. Call the tools to fetch real data — never invent or estimate values.
- To map a machine the user names (e.g. "IMA4", "IMA 5", "la Selco") to a real asset, call list_assets first, then use the exact name/code/id it returns.
- For rankings or "best/worst" questions, prefer compare_machines. For one or two specific machines, use machine_report. For counts over a specific time window (e.g. "yesterday"), use maintenance_overview with start_date/end_date. For risk / spare-parts questions, use intelligence_findings.
- You may call several tools before answering. If a tool returns an error or empty data, say so plainly.

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
