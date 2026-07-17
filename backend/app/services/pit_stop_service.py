"""Pit Stop (buffer fabrication → assemblage) — ledger math + derived state.

The zone itself is an Equipment row (block_kind='pit_stop'); its lane geometry,
late threshold and ingest token live in equipment.specifications. This service
owns everything computed on top of that:

  • `ingest_movement` — one scanned in/out movement lands in the append-only
    ledger (pit_stop_movements), anomalies FLAGGED never rejected, and the OF's
    presence timestamps (first_in_at / left_at) are maintained.
  • `compute_state` — the read model the map polls: per OF present in the buffer,
    on-hand per component, completeness vs the BOM (job_order_components), the
    derived state (awaiting/complete/released/hold/…), lateness, positions, plus
    buffer-wide KPIs (in-full count, ≥90% count, oldest OF…).

Completeness compares CUMULATIVE received (Σ in) against required — a component
stays satisfied after it exits to the line; on-hand (Σ in − Σ out) only drives
presence and the 3D stack heights.

No commit here — callers commit (same contract as job_order_service).
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    Equipment, JobOrder, JobOrderComponent, JobOrderSource, JobOrderStatus,
    Machine, PitStopCategory, PitStopDirection, PitStopHoldKind, PitStopMovement,
    PitStopOfState, PitStopSource,
)

# Defaults for equipment.specifications — every value overridable per plant
# without a migration (they ride the JSON column).
CONFIG_DEFAULTS = {
    "lanes": 41,               # parallel roller lanes
    "lane_length_ft": 44,      # physical lane length
    "slots_per_lane": 8,       # accumulation slots along one lane (display grid)
    "late_after_hours": 24,    # OF older than this (and no scheduled_date) → late
    # Client's OAV rule: an OF sitting longer than this is presumed blocked
    # ("EU en attente de réparation") and leaves the availability bands.
    "repair_after_days": 2,
    # CG/SG physical split: the FIRST `sg_lanes` lanes form the (smaller) soft-goods
    # area, the rest are case goods (7 SG vs 34 CG ≈ 5× larger). Soft goods only
    # buffer Panneaux + Quincaillerie here (rembourrage happens on the line).
    "sg_lanes": 7,
}

# Assumed SAP/HANA position format until the real one is known (see
# docs/pit-stop-sap-contract.md): "L{lane:02d}-P{slot:02d}", 1-based.
_POSITION_RE = re.compile(r"^L(\d{1,3})-P(\d{1,3})$", re.IGNORECASE)

# CG (case goods, furniture) vs SG (soft goods, sofas/upholstery) — ASSUMED rule
# until the user confirms the real one (likely encoded in the OF number): the
# product name decides (sofa/fauteuil/rembourré/coussiné… ⇒ SG); without a name,
# an OF whose BOM categories are mostly soft (rembourrage/coussins) is SG. Swap
# only `of_family` when the real rule arrives.
_SOFT_PRODUCT_RE = re.compile(r"sofa|divan|causeuse|fauteuil|rembourr|couss", re.IGNORECASE)
_SOFT_CATEGORY_RE = re.compile(r"remb|couss|soft", re.IGNORECASE)

# Categories that never gate availability (client's OAV report excludes the
# carton/BOX01SF group from DispoPit%): packaging can lag without blocking
# assembly. Matched against the category name.
_NON_GATING_CATEGORY_RE = re.compile(r"carton|box|emball", re.IGNORECASE)

# Hardware categories — feeds the board's "Dispo en attente de Quincaillerie"
# row (client's UEsansQuinc): EU that would be fully available if only the
# hardware were there.
_HARDWARE_CATEGORY_RE = re.compile(r"quinc|hardw|hwkt", re.IGNORECASE)


def of_family(product_name: Optional[str], components: list[dict]) -> str:
    """'sg' | 'cg' for one OF (assumed rule, see note above)."""
    if product_name:
        return "sg" if _SOFT_PRODUCT_RE.search(product_name) else "cg"
    soft = sum(1 for c in components if c.get("category") and _SOFT_CATEGORY_RE.search(c["category"]))
    hard = sum(1 for c in components if c.get("category") and not _SOFT_CATEGORY_RE.search(c["category"]))
    return "sg" if soft > hard else "cg"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(ts: Optional[datetime]) -> datetime:
    """Normalize an incoming timestamp to aware-UTC (naive = assumed UTC)."""
    if ts is None:
        return _now()
    return ts if ts.tzinfo is not None else ts.replace(tzinfo=timezone.utc)


def parse_position(code: Optional[str]) -> tuple[Optional[int], Optional[int]]:
    """(lane, slot) from a position code, or (None, None) when the format is
    unknown — unknown codes still display (unassigned strip), never error."""
    if not code:
        return None, None
    m = _POSITION_RE.match(code.strip())
    if not m:
        return None, None
    return int(m.group(1)), int(m.group(2))


async def get_pit_stop_equipment(db: AsyncSession, plant_id: UUID) -> Optional[Equipment]:
    """The plant's Pit Stop zone (one per plant for now)."""
    return (await db.execute(
        select(Equipment).where(
            Equipment.plant_id == plant_id,
            Equipment.block_kind == "pit_stop",
            Equipment.active == True,  # noqa: E712
        ).order_by(Equipment.created_at)
    )).scalars().first()


def pit_stop_config(eq: Equipment) -> dict:
    spec = eq.specifications if isinstance(eq.specifications, dict) else {}
    cfg = {k: spec.get(k, v) for k, v in CONFIG_DEFAULTS.items()}
    for k in ("lanes", "slots_per_lane"):
        try:
            cfg[k] = max(1, int(cfg[k]))
        except (TypeError, ValueError):
            cfg[k] = CONFIG_DEFAULTS[k]
    try:                                   # 0 ≤ sg_lanes ≤ lanes-1 (always ≥1 CG lane)
        cfg["sg_lanes"] = min(max(0, int(cfg["sg_lanes"])), cfg["lanes"] - 1)
    except (TypeError, ValueError):
        cfg["sg_lanes"] = min(CONFIG_DEFAULTS["sg_lanes"], cfg["lanes"] - 1)
    return cfg


async def get_or_create_state(db: AsyncSession, job_order_id: UUID, plant_id: UUID) -> PitStopOfState:
    st = (await db.execute(
        select(PitStopOfState).where(PitStopOfState.job_order_id == job_order_id)
    )).scalar_one_or_none()
    if st is None:
        st = PitStopOfState(job_order_id=job_order_id, plant_id=plant_id)
        db.add(st)
        await db.flush()
    return st


async def _on_hand_total(db: AsyncSession, job_order_id: UUID) -> int:
    """Σ in − Σ out across every component of one OF (its physical presence)."""
    rows = (await db.execute(
        select(PitStopMovement.direction, func.coalesce(func.sum(PitStopMovement.quantity), 0))
        .where(PitStopMovement.job_order_id == job_order_id)
        .group_by(PitStopMovement.direction)
    )).all()
    by_dir = {d: int(q) for d, q in rows}
    return by_dir.get(PitStopDirection.inbound, 0) - by_dir.get(PitStopDirection.outbound, 0)


async def ingest_movement(
    db: AsyncSession,
    plant_id: UUID,
    *,
    job_number: str,
    component_code: str,
    direction: PitStopDirection,
    quantity: int = 1,
    position_code: Optional[str] = None,
    destination: Optional[str] = None,
    occurred_at: Optional[datetime] = None,
    source: PitStopSource = PitStopSource.sap,
    raw: Optional[dict] = None,
) -> PitStopMovement:
    """Record one movement. NEVER rejects a plausible event: unknown OFs are
    created on the fly, unknown components / duplicates / negative balances are
    recorded WITH an anomaly flag (the physical world already happened). Keeps
    PitStopOfState presence timestamps consistent. Does NOT commit."""
    when = _aware(occurred_at)
    number = (job_number or "").strip()
    code = (component_code or "").strip()
    qty = max(1, int(quantity or 1))
    anomaly: Optional[str] = None

    jo = (await db.execute(
        select(JobOrder).where(JobOrder.job_number == number, JobOrder.plant_id == plant_id)
    )).scalar_one_or_none()
    if jo is None:
        anomaly = "unknown_of"
        jo = JobOrder(
            job_number=number,
            plant_id=plant_id,
            status=JobOrderStatus.in_progress,
            source=JobOrderSource.erp if source == PitStopSource.sap else JobOrderSource.manual,
        )
        db.add(jo)
        await db.flush()

    if anomaly is None:
        in_bom = (await db.execute(
            select(JobOrderComponent.id).where(
                JobOrderComponent.job_order_id == jo.id,
                JobOrderComponent.component_code == code,
            )
        )).first()
        if in_bom is None:
            anomaly = "unknown_component"

    if anomaly is None:
        dup = (await db.execute(
            select(PitStopMovement.id).where(
                PitStopMovement.job_order_id == jo.id,
                PitStopMovement.component_code == code,
                PitStopMovement.direction == direction,
                PitStopMovement.quantity == qty,
                PitStopMovement.position_code == position_code,
                PitStopMovement.occurred_at == when,
            )
        )).first()
        if dup is not None:
            anomaly = "duplicate"

    if anomaly is None and direction == PitStopDirection.outbound:
        rows = (await db.execute(
            select(PitStopMovement.direction, func.coalesce(func.sum(PitStopMovement.quantity), 0))
            .where(PitStopMovement.job_order_id == jo.id, PitStopMovement.component_code == code)
            .group_by(PitStopMovement.direction)
        )).all()
        by_dir = {d: int(q) for d, q in rows}
        balance = by_dir.get(PitStopDirection.inbound, 0) - by_dir.get(PitStopDirection.outbound, 0)
        if balance - qty < 0:
            anomaly = "negative_balance"

    dest_machine: Optional[Machine] = None
    if destination:
        ref = destination.strip()
        q = select(Machine).where(Machine.plant_id == plant_id)
        try:
            dest_machine = (await db.execute(q.where(Machine.id == UUID(ref)))).scalar_one_or_none()
        except ValueError:
            dest_machine = (await db.execute(
                q.where((Machine.code == ref) | (Machine.page_slug == ref))
            )).scalars().first()

    mv = PitStopMovement(
        plant_id=plant_id,
        job_order_id=jo.id,
        component_code=code,
        direction=direction,
        quantity=qty,
        position_code=(position_code or "").strip() or None,
        destination_machine_id=dest_machine.id if dest_machine else None,
        occurred_at=when,
        source=source,
        anomaly=anomaly,
        raw=raw,
    )
    db.add(mv)

    st = await get_or_create_state(db, jo.id, plant_id)
    if direction == PitStopDirection.inbound:
        if st.first_in_at is None or when < _aware(st.first_in_at):
            st.first_in_at = when
        st.left_at = None                       # goods present again
    if st.last_movement_at is None or when > _aware(st.last_movement_at):
        st.last_movement_at = when
    if dest_machine is not None:
        st.destination_machine_id = dest_machine.id

    await db.flush()
    if direction == PitStopDirection.outbound and await _on_hand_total(db, jo.id) <= 0:
        st.left_at = when
        await db.flush()
    return mv


async def compute_state(db: AsyncSession, plant_id: UUID, *, now: Optional[datetime] = None) -> Optional[dict]:
    """The Pit Stop read model for one plant (None when no zone is configured).
    Only OFs physically present (on-hand > 0) are returned."""
    eq = await get_pit_stop_equipment(db, plant_id)
    if eq is None:
        return None
    now = now or _now()
    cfg = pit_stop_config(eq)

    # Ledger aggregate: (of, component, direction) → Σ qty
    rows = (await db.execute(
        select(
            PitStopMovement.job_order_id,
            PitStopMovement.component_code,
            PitStopMovement.direction,
            func.coalesce(func.sum(PitStopMovement.quantity), 0),
        )
        .where(PitStopMovement.plant_id == plant_id)
        .group_by(PitStopMovement.job_order_id, PitStopMovement.component_code, PitStopMovement.direction)
    )).all()
    received: dict[UUID, dict[str, int]] = {}
    shipped: dict[UUID, dict[str, int]] = {}
    for of_id, code, direction, qty in rows:
        bucket = received if direction == PitStopDirection.inbound else shipped
        bucket.setdefault(of_id, {})[code] = bucket.get(of_id, {}).get(code, 0) + int(qty)

    of_ids = [of_id for of_id in received
              if sum(received[of_id].values()) - sum(shipped.get(of_id, {}).values()) > 0]
    if not of_ids:
        return {
            "plant_id": str(plant_id), "equipment_id": str(eq.id), "config": cfg,
            "categories": await _categories(db, plant_id),
            "ofs": [], "kpis": _kpis([], cfg), "generated_at": now.isoformat(),
        }

    # Positions: distinct inbound position codes per OF, most recent first.
    pos_rows = (await db.execute(
        select(
            PitStopMovement.job_order_id,
            PitStopMovement.position_code,
            func.max(PitStopMovement.occurred_at),
        )
        .where(
            PitStopMovement.plant_id == plant_id,
            PitStopMovement.job_order_id.in_(of_ids),
            PitStopMovement.direction == PitStopDirection.inbound,
            PitStopMovement.position_code.isnot(None),
        )
        .group_by(PitStopMovement.job_order_id, PitStopMovement.position_code)
    )).all()
    positions: dict[UUID, list[tuple[str, datetime]]] = {}
    for of_id, code, last_at in pos_rows:
        positions.setdefault(of_id, []).append((code, last_at))
    for lst in positions.values():
        lst.sort(key=lambda t: _aware(t[1]), reverse=True)

    bom_rows = (await db.execute(
        select(JobOrderComponent).where(JobOrderComponent.job_order_id.in_(of_ids))
    )).scalars().all()
    bom: dict[UUID, list[JobOrderComponent]] = {}
    for c in bom_rows:
        bom.setdefault(c.job_order_id, []).append(c)

    orders = {j.id: j for j in (await db.execute(
        select(JobOrder).where(JobOrder.id.in_(of_ids))
    )).scalars().all()}
    states = {s.job_order_id: s for s in (await db.execute(
        select(PitStopOfState).where(PitStopOfState.job_order_id.in_(of_ids))
    )).scalars().all()}
    dest_ids = {s.destination_machine_id for s in states.values() if s.destination_machine_id}
    machines = {m.id: m for m in (await db.execute(
        select(Machine).where(Machine.id.in_(dest_ids))
    )).scalars().all()} if dest_ids else {}

    ofs = []
    for of_id in of_ids:
        jo = orders.get(of_id)
        if jo is None:
            continue
        st = states.get(of_id)
        got = received.get(of_id, {})
        out = shipped.get(of_id, {})
        lines = bom.get(of_id, [])
        bom_codes = {c.component_code for c in lines}

        components = []
        for c in sorted(lines, key=lambda c: c.component_code):
            r = got.get(c.component_code, 0)
            components.append({
                "code": c.component_code, "label": c.label, "category": c.category,
                "required": c.required_qty, "received": r,
                "on_hand": max(0, r - out.get(c.component_code, 0)),
                "missing": max(0, c.required_qty - r),
                "in_bom": True,
            })
        for code in sorted(set(got) - bom_codes):        # received outside the BOM
            r = got.get(code, 0)
            components.append({
                "code": code, "label": None, "category": None,
                "required": 0, "received": r,
                "on_hand": max(0, r - out.get(code, 0)),
                "missing": 0, "in_bom": False,
            })

        # Completeness mirrors the client's DispoPit% (OAV report, verified on
        # PDPAssemblageQS): availability per component CATEGORY (Σ min(received,
        # required) / Σ required inside the group), and the OF's completeness is
        # the MINIMUM across categories — weakest link — with non-gating
        # categories (carton) excluded unless they are all the OF has.
        by_cat: dict[str, int] = {}
        got_by_cat: dict[str, float] = {}
        for c in lines:
            if c.required_qty <= 0:
                continue
            cat = c.category or ""
            by_cat[cat] = by_cat.get(cat, 0) + c.required_qty
            got_by_cat[cat] = got_by_cat.get(cat, 0) + min(got.get(c.component_code, 0), c.required_qty)
        cat_pcts = {cat: got_by_cat[cat] / req for cat, req in by_cat.items()}
        gating = [p for cat, p in cat_pcts.items() if not _NON_GATING_CATEGORY_RE.search(cat)]
        pct = min(gating or cat_pcts.values(), default=None)
        # in_full stays physical: EVERY BOM line satisfied, carton included —
        # it drives the release confirmation, not the availability bands.
        in_full = bool(lines) and all(got.get(c.component_code, 0) >= c.required_qty for c in lines)

        if jo.status == JobOrderStatus.cancelled:
            state = "cancelled"
        elif st is not None and st.hold_kind is not None:
            state = st.hold_kind.value
        elif st is not None and st.released_at is not None:
            state = "released"
        elif in_full:
            state = "complete"
        else:
            state = "awaiting"

        first_in = _aware(st.first_in_at) if st is not None and st.first_in_at else None
        age_min = int((now - first_in).total_seconds() // 60) if first_in else None
        if jo.scheduled_date is not None:
            late = now.date() > jo.scheduled_date and state not in ("released", "cancelled")
        else:
            late = (age_min is not None and age_min > cfg["late_after_hours"] * 60
                    and state not in ("released", "cancelled"))

        dest = machines.get(st.destination_machine_id) if st is not None else None
        of_positions = []
        for code, _at in positions.get(of_id, []):
            lane, slot = parse_position(code)
            of_positions.append({"code": code, "lane": lane, "slot": slot})

        ofs.append({
            "job_order_id": str(of_id),
            "job_number": jo.job_number,
            "product_name": jo.product_name,
            "family": of_family(jo.product_name, components),
            # EU = target_quantity × eu_per_unit (1 EU = 100 s of line time);
            # missing factor counts 1 EU per unit so demo data still sums.
            "equivalent_units": round(
                (jo.target_quantity or 0) * (jo.eu_per_unit if jo.eu_per_unit is not None else 1.0), 1),
            "state": state,
            "hold_kind": st.hold_kind.value if st is not None and st.hold_kind else None,
            "hold_reason": st.hold_reason if st is not None else None,
            "late": late,
            "completeness_pct": round(pct * 100, 1) if pct is not None else None,
            "in_full": in_full,
            "priority": st.priority if st is not None else None,
            "destination_machine_id": str(dest.id) if dest else None,
            "destination_name": dest.name if dest else None,
            "positions": of_positions,
            "on_hand_total": sum(max(0, got.get(k, 0) - out.get(k, 0)) for k in got),
            "first_in_at": first_in.isoformat() if first_in else None,
            "age_minutes": age_min,
            "released_at": st.released_at.isoformat() if st is not None and st.released_at else None,
            "scheduled_date": jo.scheduled_date.isoformat() if jo.scheduled_date else None,
            "components": components,
        })

    # Stable display order: priority first (lower = more urgent), then oldest.
    ofs.sort(key=lambda o: (o["priority"] is None, o["priority"] or 0, -(o["age_minutes"] or 0)))
    return {
        "plant_id": str(plant_id), "equipment_id": str(eq.id), "config": cfg,
        "categories": await _categories(db, plant_id),
        "ofs": ofs, "kpis": _kpis(ofs, cfg), "generated_at": now.isoformat(),
    }


async def _categories(db: AsyncSession, plant_id: UUID) -> list[dict]:
    rows = (await db.execute(
        select(PitStopCategory).where(PitStopCategory.plant_id == plant_id)
        .order_by(PitStopCategory.sort_order, PitStopCategory.name)
    )).scalars().all()
    return [{"name": c.name, "color": c.color, "family": c.family or "both"} for c in rows]


def _kpis(ofs: list[dict], cfg: dict) -> dict:
    ages = [o["age_minutes"] for o in ofs if o["age_minutes"] is not None]
    oldest = max(ofs, key=lambda o: o["age_minutes"] or -1, default=None)
    repair_min = int(float(cfg.get("repair_after_days", CONFIG_DEFAULTS["repair_after_days"])) * 1440)
    return {
        "total": len(ofs),
        # Availability bands follow the client's DispoPit% semantics: 100 %
        # available (even if a non-gating carton line is short), and STRICTLY
        # over 90 % (their SUMIFS uses ">90", not ">=").
        "in_full": sum(1 for o in ofs if o["completeness_pct"] is not None
                       and o["completeness_pct"] >= 100),
        "almost": sum(1 for o in ofs if o["completeness_pct"] is not None
                      and 90 < o["completeness_pct"] < 100),
        "awaiting": sum(1 for o in ofs if o["state"] == "awaiting"),
        "on_hold": sum(1 for o in ofs if o["state"] in ("hold", "quality", "rework")),
        "released": sum(1 for o in ofs if o["state"] == "released"),
        "late": sum(1 for o in ofs if o["late"]),
        "oldest_job_number": oldest["job_number"] if oldest and oldest["age_minutes"] is not None else None,
        "oldest_age_minutes": oldest["age_minutes"] if oldest else None,
        "avg_age_minutes": int(sum(ages) / len(ages)) if ages else None,
        "otif": _otif_bands(ofs, repair_min),
        "board": _board(ofs, repair_min),
    }


def _active(ofs: list[dict]) -> list[dict]:
    """OFs that carry availability metrics: not cancelled, with a BOM."""
    return [o for o in ofs if o["state"] != "cancelled" and o["completeness_pct"] is not None]


def _eu_dispo(o: dict) -> float:
    """Availability-weighted EU — the client's UEdispo (EU × DispoPit%)."""
    return o["equivalent_units"] * o["completeness_pct"] / 100


def _in_repair(o: dict, repair_min: int) -> bool:
    """Client's "EU en attente de réparation": an OF sitting past the age
    threshold is presumed blocked and leaves the availability bands."""
    return o["age_minutes"] is not None and o["age_minutes"] > repair_min


def _category_pcts(o: dict) -> dict[str, float]:
    """Availability % per component category of one OF payload."""
    req: dict[str, int] = {}
    got: dict[str, float] = {}
    for c in o["components"]:
        if not c["in_bom"] or c["required"] <= 0:
            continue
        cat = c["category"] or ""
        req[cat] = req.get(cat, 0) + c["required"]
        got[cat] = got.get(cat, 0) + min(c["received"], c["required"])
    return {cat: 100 * got[cat] / r for cat, r in req.items()}


def _blocked_only_by_hardware(o: dict) -> bool:
    """True when every gating category except the hardware one(s) is at 100 % —
    the OF would be fully available if the quincaillerie arrived."""
    if o["completeness_pct"] is None or o["completeness_pct"] >= 100:
        return False
    pcts = _category_pcts(o)
    hw = [p for cat, p in pcts.items()
          if _HARDWARE_CATEGORY_RE.search(cat) and not _NON_GATING_CATEGORY_RE.search(cat)]
    others = [p for cat, p in pcts.items()
              if not _HARDWARE_CATEGORY_RE.search(cat) and not _NON_GATING_CATEGORY_RE.search(cat)]
    return bool(hw) and min(hw) < 100 and (not others or min(others) >= 100)


def _otif_bands(ofs: list[dict], repair_min: int) -> dict:
    """The availability table on the Pit Stop TV — aligned with the client's OTIF
    PIT report (PDPAssemblageQS, sheet OAV, formulas verified 2026-07-16):
      full : completeness = 100 % (their DispoPit% = 100)
      ge90 : completeness STRICTLY > 90 %, CUMULATIVE (includes the full band)
    EU are availability-weighted like their UEdispo (EU × DispoPit%). OFs past
    the repair-age threshold leave both bands AND the denominator (their N7/N2:
    EU total nets out the "en attente de réparation" EU), and OTIF % = band CG
    EU ÷ that net total. Cancelled OFs and OFs without a BOM stay out of every
    set (no metric ≠ missing material)."""
    fresh = [o for o in _active(ofs) if not _in_repair(o, repair_min)]
    total_cg_eu = sum(_eu_dispo(o) for o in fresh if o["family"] == "cg")

    def band(members: list[dict]) -> dict:
        cg_eu = sum(_eu_dispo(o) for o in members if o["family"] == "cg")
        return {
            "cg_eu": round(cg_eu),
            "sg_eu": round(sum(_eu_dispo(o) for o in members if o["family"] == "sg")),
            "otif_pct": round(100 * cg_eu / total_cg_eu) if total_cg_eu > 0 else None,
            "cg_ofs": sum(1 for o in members if o["family"] == "cg"),
        }

    return {
        "full": band([o for o in fresh if o["completeness_pct"] >= 100]),
        "ge90": band([o for o in fresh if o["completeness_pct"] > 90]),
    }


def _board(ofs: list[dict], repair_min: int) -> dict:
    """The client's Feuil1 KPI table (per family CG/SG, availability-weighted EU).
    Mapping onto our v1 model: "assigned to a line" = released (the manual
    release is our line-assignment act); everything else waits in the pit.
      eu_pit               : Σ UEdispo of the non-released, non-repair OFs
      on_line              : Σ UEdispo of the released, non-repair OFs
      eu_total             : pit + on_line (their N2 — repair already netted out)
      assigned_unavailable : Σ (EU − UEdispo) of the released OFs (their N5)
      awaiting_hardware    : Σ full EU of OFs blocked ONLY by quincaillerie
      awaiting_repair      : Σ UEdispo of OFs past the repair-age threshold"""
    active = _active(ofs)
    fresh = [o for o in active if not _in_repair(o, repair_min)]

    def pair(members: list[dict], value) -> dict:
        return {
            "cg": round(sum(value(o) for o in members if o["family"] == "cg")),
            "sg": round(sum(value(o) for o in members if o["family"] == "sg")),
        }

    pit = [o for o in fresh if o["state"] != "released"]
    on_line = [o for o in fresh if o["state"] == "released"]
    return {
        "eu_pit": pair(pit, _eu_dispo),
        "on_line": pair(on_line, _eu_dispo),
        "eu_total": pair(fresh, _eu_dispo),
        "assigned_unavailable": pair(
            [o for o in active if o["state"] == "released"],
            lambda o: o["equivalent_units"] - _eu_dispo(o)),
        "awaiting_hardware": pair(
            [o for o in active if _blocked_only_by_hardware(o)],
            lambda o: o["equivalent_units"]),
        "awaiting_repair": pair(
            [o for o in active if _in_repair(o, repair_min)], _eu_dispo),
    }
