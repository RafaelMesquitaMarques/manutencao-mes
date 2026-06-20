"""
Maintenance Intelligence — API Routes
=====================================
/api/intelligence/*

All endpoints require authentication (get_current_user).
Only users with maintenance dashboard access can use these endpoints.
The AI never executes actions — analysis and recommendations only.
"""

from __future__ import annotations

import uuid
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, BackgroundTasks
from sqlalchemy import select, desc, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import (
    User, AIInsight, AIRecommendation, MachineRiskScore, SparePartRisk
)
from app.schemas.intelligence import (
    GenerateInsightRequest,
    InsightOut,
    InsightListResponse,
    MachineRiskListResponse,
    MachineRiskScoreOut,
    SparePartRiskListResponse,
    SparePartRiskOut,
    RecommendationOut,
    AcknowledgeRecommendationRequest,
    ChatAskRequest,
    ChatAskResponse,
)
from app.services.intelligence_calculator import build_findings
from app.services.intelligence_ai import generate_insight_text
from app.services.intelligence_chat import answer_question

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/intelligence", tags=["intelligence"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_maintenance_access(current_user: User) -> None:
    """
    Enforces that only users with maintenance-related roles can access
    intelligence endpoints. Respects the existing permission model.
    Roles allowed: technician, supervisor, plant_manager, director, admin,
                   maintenance_director (added in alerts/tickets session).
    """
    allowed_roles = {
        "technician", "supervisor", "plant_manager",
        "director", "admin", "maintenance_director",
    }
    # Use the user's role column directly. Accessing the plant_assignments
    # relationship here would trigger an async lazy-load (MissingGreenlet);
    # the global role on the user record is the source of truth for access.
    role = current_user.role
    role_value = role.value if hasattr(role, "value") else str(role)
    if role_value not in allowed_roles:
        raise HTTPException(
            status_code=403,
            detail="Access to maintenance intelligence requires a maintenance role."
        )


async def _insight_to_dict(insight: AIInsight, db: AsyncSession) -> dict:
    """
    Safe conversion of AIInsight ORM object to dict for Pydantic validation.
    Avoids MissingGreenlet errors from async lazy-load of relationships.
    (Same pattern as _ticket_to_dict in tickets.py)
    """
    from sqlalchemy import inspect as sa_inspect

    mapper  = sa_inspect(type(insight)).mapper
    columns = {attr.key for attr in mapper.column_attrs}
    d = {col: getattr(insight, col) for col in columns}

    # Manually fetch recommendations to avoid lazy load
    rec_result = await db.execute(
        select(AIRecommendation)
        .where(AIRecommendation.insight_id == insight.id)
        .order_by(AIRecommendation.created_at)
    )
    recs = rec_result.scalars().all()
    d["recommendations"] = [
        {col: getattr(r, col) for col in {a.key for a in sa_inspect(type(r)).mapper.column_attrs}}
        for r in recs
    ]
    return d


# ---------------------------------------------------------------------------
# POST /api/intelligence/ask  — conversational Q&A over live data (tool-use)
# ---------------------------------------------------------------------------

@router.post("/ask", response_model=ChatAskResponse)
async def ask_intelligence(
    body:         ChatAskRequest,
    db:           AsyncSession = Depends(get_db),
    current_user: User         = Depends(get_current_user),
):
    """Answer a natural-language question by letting Claude call read-only data
    tools (machines, KPIs, tickets, findings). Analysis only — never acts."""
    _check_maintenance_access(current_user)
    result = await answer_question(
        db=db,
        current_user=current_user,
        messages=[m.model_dump() for m in body.messages],
        language=body.language,
    )
    return ChatAskResponse(**result)


# ---------------------------------------------------------------------------
# POST /api/intelligence/generate
# ---------------------------------------------------------------------------

@router.post("/generate", response_model=InsightOut, status_code=201)
async def generate_insight(
    body:         GenerateInsightRequest,
    db:           AsyncSession  = Depends(get_db),
    current_user: User          = Depends(get_current_user),
):
    """
    Generates a new maintenance intelligence insight.

    Steps:
    1. Runs the deterministic calculation engine (always).
    2. Calls AI layer to transform findings into natural language (if API key set).
    3. Stores insight + recommendations in the database.
    4. Returns the complete InsightOut.

    This endpoint is idempotent per period: calling it again for the same
    period regenerates a fresh insight (new row — history is preserved).
    """
    _check_maintenance_access(current_user)

    now          = datetime.now(timezone.utc)
    period_end   = now
    period_start = now - timedelta(days=body.period_days)

    logger.info(
        "Generating intelligence insight | type=%s lang=%s days=%d user=%s",
        body.insight_type, body.language, body.period_days, current_user.id
    )

    # ── Step 1: Calculate findings ────────────────────────────────────────
    try:
        findings = await build_findings(
            db=db,
            period_days=body.period_days,
            plant_id=str(body.plant_id) if body.plant_id else None,
        )
    except Exception as exc:
        logger.exception("Calculation engine failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Calculation engine error: {exc}")

    # ── Step 2: Generate AI text ──────────────────────────────────────────
    try:
        insight_text, ai_generated = await generate_insight_text(
            findings=findings,
            language=body.language,
            insight_type=body.insight_type,
        )
    except Exception as exc:
        logger.exception("AI text generation failed: %s", exc)
        # Non-fatal: store the findings without AI text
        insight_text = f"[AI generation failed: {exc}]"
        ai_generated = False

    # ── Step 3: Store insight ─────────────────────────────────────────────
    from app.core.config import settings

    insight = AIInsight(
        plant_id             = body.plant_id,
        insight_type         = body.insight_type,
        language             = body.language,
        period_start         = period_start,
        period_end           = period_end,
        period_days          = body.period_days,
        findings_json        = findings,
        insight_text         = insight_text,
        ai_generated         = ai_generated,
        generated_by_model   = "claude-sonnet-4-6" if ai_generated else None,
        generated_by_user_id = current_user.id,
    )
    db.add(insight)
    await db.flush()  # get insight.id before creating child records

    # ── Step 4: Store machine risk scores ─────────────────────────────────
    for machine_data in findings.get("machine_risks", []):
        risk_score = MachineRiskScore(
            machine_id              = _try_uuid(machine_data.get("machine_id")),
            machine_name            = machine_data.get("machine_name", ""),
            score                   = machine_data.get("_score", 0),
            risk_level              = machine_data.get("risk_level", "low"),
            hours_since_last_ticket = machine_data.get("_hours_since_last_ticket"),
            historical_mtbf_hours   = machine_data.get("_historical_mtbf_hours"),
            recent_ticket_count     = machine_data.get("ticket_count_period", 0),
            criticality_factor      = machine_data.get("_criticality_factor", 1.0),
            top_failure_modes       = machine_data.get("top_problem_types", []),
            insight_id              = insight.id,
        )
        db.add(risk_score)

    # ── Step 5: Store spare parts risk ────────────────────────────────────
    for part_data in findings.get("spare_parts_at_risk", []):
        part_risk = SparePartRisk(
            stock_item_id          = _try_uuid(part_data.get("stock_item_id")),
            part_code              = part_data.get("part_code", ""),
            part_name              = part_data.get("part_name", ""),
            current_qty            = part_data.get("current_qty", 0),
            safety_qty             = part_data.get("min_qty", 0),
            avg_consumption_30d    = part_data.get("avg_consumption_30d", 0),
            recent_consumption_30d = part_data.get("consumption_last_30d", 0),
            consumption_trend      = part_data.get("consumption_trend", "stable"),
            linked_machines        = part_data.get("linked_machines", []),
            risk_level             = part_data.get("risk_level", "low"),
            days_until_stockout    = part_data.get("days_until_stockout"),
            insight_id             = insight.id,
        )
        db.add(part_risk)

    # ── Step 6: Generate and store recommendations ────────────────────────
    recommendations = _extract_recommendations(findings, insight.id)
    for rec in recommendations:
        db.add(rec)

    await db.commit()
    await db.refresh(insight)

    d = await _insight_to_dict(insight, db)
    return InsightOut.model_validate(d)


# ---------------------------------------------------------------------------
# GET /api/intelligence/latest
# ---------------------------------------------------------------------------

@router.get("/latest", response_model=InsightOut)
async def get_latest_insight(
    language:     str           = Query(default="en", pattern="^(en|fr|es)$"),
    insight_type: str           = Query(default="full_report"),
    db:           AsyncSession  = Depends(get_db),
    current_user: User          = Depends(get_current_user),
):
    """
    Returns the most recently generated insight for the given language and type.
    Used by the dashboard to display the current intelligence state.
    """
    _check_maintenance_access(current_user)

    result = await db.execute(
        select(AIInsight)
        .where(
            and_(
                AIInsight.language     == language,
                AIInsight.insight_type == insight_type,
            )
        )
        .order_by(desc(AIInsight.generated_at))
        .limit(1)
    )
    insight = result.scalar_one_or_none()

    if not insight:
        raise HTTPException(
            status_code=404,
            detail="No insight found. Generate one first via POST /api/intelligence/generate"
        )

    d = await _insight_to_dict(insight, db)
    return InsightOut.model_validate(d)


# ---------------------------------------------------------------------------
# GET /api/intelligence/history
# ---------------------------------------------------------------------------

@router.get("/history", response_model=InsightListResponse)
async def get_insight_history(
    language:     Optional[str] = Query(default=None),
    insight_type: Optional[str] = Query(default=None),
    limit:        int           = Query(default=20, ge=1, le=100),
    offset:       int           = Query(default=0, ge=0),
    db:           AsyncSession  = Depends(get_db),
    current_user: User          = Depends(get_current_user),
):
    """
    Returns paginated history of all generated insights.
    Allows the maintenance team to review and compare previous analyses.
    """
    _check_maintenance_access(current_user)

    filters = []
    if language:
        filters.append(AIInsight.language == language)
    if insight_type:
        filters.append(AIInsight.insight_type == insight_type)

    count_result = await db.execute(
        select(AIInsight).where(and_(*filters)) if filters
        else select(AIInsight)
    )
    total = len(count_result.scalars().all())

    result = await db.execute(
        (select(AIInsight).where(and_(*filters)) if filters else select(AIInsight))
        .order_by(desc(AIInsight.generated_at))
        .limit(limit)
        .offset(offset)
    )
    insights = result.scalars().all()

    items = []
    for ins in insights:
        d = await _insight_to_dict(ins, db)
        items.append(InsightOut.model_validate(d))

    return InsightListResponse(total=total, items=items)


# ---------------------------------------------------------------------------
# GET /api/intelligence/risk-scores
# ---------------------------------------------------------------------------

@router.get("/risk-scores", response_model=MachineRiskListResponse)
async def get_risk_scores(
    limit:        int           = Query(default=50, ge=1, le=200),
    risk_level:   Optional[str] = Query(default=None),
    db:           AsyncSession  = Depends(get_db),
    current_user: User          = Depends(get_current_user),
):
    """
    Returns the latest risk score per machine.
    Deduplicated: only the most recent score per machine is returned.
    """
    _check_maintenance_access(current_user)

    # Get the most recent computed_at per machine
    from sqlalchemy import func

    subq = (
        select(
            MachineRiskScore.machine_id,
            func.max(MachineRiskScore.computed_at).label("latest")
        )
        .group_by(MachineRiskScore.machine_id)
        .subquery()
    )

    query = (
        select(MachineRiskScore)
        .join(
            subq,
            and_(
                MachineRiskScore.machine_id   == subq.c.machine_id,
                MachineRiskScore.computed_at  == subq.c.latest,
            )
        )
        .order_by(desc(MachineRiskScore.score))
        .limit(limit)
    )

    if risk_level:
        query = query.where(MachineRiskScore.risk_level == risk_level)

    result = await db.execute(query)
    scores = result.scalars().all()

    from sqlalchemy import inspect as sa_inspect
    items = []
    for s in scores:
        mapper  = sa_inspect(type(s)).mapper
        columns = {attr.key for attr in mapper.column_attrs}
        d = {col: getattr(s, col) for col in columns}
        # Add machine_name for the response schema
        if not d.get("machine_name"):
            d["machine_name"] = str(d.get("machine_id", ""))
        items.append(MachineRiskScoreOut.model_validate(d))

    return MachineRiskListResponse(total=len(items), items=items)


# ---------------------------------------------------------------------------
# GET /api/intelligence/spare-parts-risk
# ---------------------------------------------------------------------------

@router.get("/spare-parts-risk", response_model=SparePartRiskListResponse)
async def get_spare_parts_risk(
    risk_level: Optional[str] = Query(default=None),
    db:         AsyncSession  = Depends(get_db),
    current_user: User        = Depends(get_current_user),
):
    """
    Returns the latest spare parts risk assessment.
    Filters to parts that are at risk (medium / high / critical).
    """
    _check_maintenance_access(current_user)

    from sqlalchemy import func, inspect as sa_inspect

    # Latest per part
    subq = (
        select(
            SparePartRisk.stock_item_id,
            func.max(SparePartRisk.computed_at).label("latest")
        )
        .group_by(SparePartRisk.stock_item_id)
        .subquery()
    )

    query = (
        select(SparePartRisk)
        .join(
            subq,
            and_(
                SparePartRisk.stock_item_id == subq.c.stock_item_id,
                SparePartRisk.computed_at   == subq.c.latest,
            )
        )
        .order_by(desc(SparePartRisk.computed_at))
    )

    if risk_level:
        query = query.where(SparePartRisk.risk_level == risk_level)

    result = await db.execute(query)
    parts  = result.scalars().all()

    items = []
    for p in parts:
        mapper  = sa_inspect(type(p)).mapper
        columns = {attr.key for attr in mapper.column_attrs}
        d = {col: getattr(p, col) for col in columns}
        items.append(SparePartRiskOut.model_validate(d))

    return SparePartRiskListResponse(total=len(items), items=items)


# ---------------------------------------------------------------------------
# PATCH /api/intelligence/recommendations/{id}/acknowledge
# ---------------------------------------------------------------------------

@router.patch("/recommendations/{recommendation_id}/acknowledge", response_model=RecommendationOut)
async def acknowledge_recommendation(
    recommendation_id: uuid.UUID,
    body:              AcknowledgeRecommendationRequest,
    db:                AsyncSession = Depends(get_db),
    current_user:      User         = Depends(get_current_user),
):
    """
    Marks a recommendation as acknowledged by a user.
    Does NOT execute any action — acknowledgement only.
    """
    _check_maintenance_access(current_user)

    result = await db.execute(
        select(AIRecommendation).where(AIRecommendation.id == recommendation_id)
    )
    rec = result.scalar_one_or_none()

    if not rec:
        raise HTTPException(status_code=404, detail="Recommendation not found.")

    rec.status           = "acknowledged"
    rec.acknowledged_by  = body.acknowledged_by
    rec.acknowledged_at  = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(rec)

    from sqlalchemy import inspect as sa_inspect
    mapper  = sa_inspect(type(rec)).mapper
    columns = {attr.key for attr in mapper.column_attrs}
    d = {col: getattr(rec, col) for col in columns}
    return RecommendationOut.model_validate(d)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _extract_recommendations(findings: dict, insight_id: uuid.UUID) -> list[AIRecommendation]:
    """
    Extracts structured recommendations from findings data.
    These are deterministic recommendations based on clear thresholds —
    not AI-generated. The AI text above provides richer narrative context.
    """
    recs: list[AIRecommendation] = []

    # ── Critical / high-risk machines ─────────────────────────────────────
    for machine in findings.get("machine_risks", []):
        if machine["risk_level"] in ("critical", "high"):
            days_since = machine.get("days_since_last_ticket")
            mtbf       = machine.get("avg_mtbf_days")
            problems   = ", ".join(machine.get("top_problem_types", [])[:2]) or "various issues"

            evidence = (
                f"{machine['ticket_count_period']} tickets in the period. "
                f"Days since last ticket: {f'{days_since:.1f}' if days_since else 'unknown'}. "
                f"Ticket-based MTBF: {f'{mtbf:.1f} days' if mtbf else 'insufficient data'}. "
                f"Top issues: {problems}."
            )
            recs.append(AIRecommendation(
                insight_id       = insight_id,
                title            = f"Inspect {machine['machine_name']}",
                evidence         = evidence,
                impact           = f"Machine classified as {machine['risk_level']} risk based on ticket frequency and historical patterns.",
                recommendation   = "Perform a quick inspection during next setup or shift change. Verify recent failure modes and check related components.",
                risk_level       = machine["risk_level"],
                related_machine_id = _try_uuid(machine.get("machine_id")),
                related_category = "machine_risk",
                confidence       = 0.75 if mtbf else 0.5,
            ))

    # ── Top irritants ─────────────────────────────────────────────────────
    for irritant in findings.get("top_irritants", [])[:3]:
        if irritant["risk_level"] in ("critical", "high"):
            recs.append(AIRecommendation(
                insight_id       = insight_id,
                title            = f"Address recurring failures on {irritant['machine_name']}",
                evidence         = (
                    f"{irritant['ticket_count']} tickets, "
                    f"{irritant['total_downtime_minutes']} min downtime, "
                    f"recurrence score: {irritant['recurrence_score']:.0%}. "
                    f"Top problem: {irritant['top_problem_type']}."
                ),
                impact           = "Recurring failures indicate a systematic issue requiring root cause analysis.",
                recommendation   = (
                    "Perform root cause analysis on the recurring failure. "
                    "Standardize the troubleshooting procedure. "
                    "Review PM plan for this machine."
                ),
                risk_level       = irritant["risk_level"],
                related_machine_id = _try_uuid(irritant.get("machine_id")),
                related_category = "top_irritants",
                confidence       = 0.8,
            ))

    # ── Critical spare parts ──────────────────────────────────────────────
    for part in findings.get("spare_parts_at_risk", []):
        if part["risk_level"] in ("critical", "high"):
            days_out = part.get("days_until_stockout")
            recs.append(AIRecommendation(
                insight_id       = insight_id,
                title            = f"Replenish {part['part_code']} — {part['part_name']}",
                evidence         = (
                    f"Current stock: {part['current_qty']}. "
                    f"Minimum stock: {part['min_qty']}. "
                    f"Recent consumption (30d): {part['consumption_last_30d']}. "
                    f"Trend: {part['consumption_trend']}."
                    + (f" Estimated stockout in {days_out:.0f} days." if days_out else "")
                ),
                impact           = "Stock below minimum. Risk of maintenance delay if part is needed for an unplanned repair.",
                recommendation   = (
                    "Review min/max stock levels. "
                    "Initiate replenishment request. "
                    "Investigate consumption increase if trend is abnormal."
                ),
                risk_level       = part["risk_level"],
                related_category = "spare_parts",
                confidence       = 0.9,
            ))

    # ── Technician concentration ──────────────────────────────────────────
    if findings.get("concentration_risk"):
        workload = findings.get("technician_workload", [])
        top2     = workload[:2] if len(workload) >= 2 else workload
        top2_pct = sum(w["pct_of_team_tickets"] for w in top2)
        names    = " and ".join(w["technician_name"] for w in top2)
        recs.append(AIRecommendation(
            insight_id       = insight_id,
            title            = "Develop cross-training to reduce technician dependency",
            evidence         = (
                f"Top 2 technicians ({names}) handle {top2_pct:.0f}% of all tickets. "
                f"This creates a single point of failure for maintenance coverage."
            ),
            impact           = "Knowledge concentration increases risk if key technicians are unavailable.",
            recommendation   = (
                "Identify the top 2-3 intervention types handled by the concentrated technicians. "
                "Develop cross-training for at least 2 additional team members. "
                "Document troubleshooting procedures to reduce knowledge dependency."
            ),
            risk_level       = "medium",
            related_category = "technician_workload",
            confidence       = 0.85,
        ))

    return recs


def _try_uuid(value) -> Optional[uuid.UUID]:
    """Safely convert a string to UUID, returning None if invalid."""
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError):
        return None
