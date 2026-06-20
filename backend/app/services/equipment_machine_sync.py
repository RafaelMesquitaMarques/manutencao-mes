"""Keep the Machine/kiosk layer in sync with an Equipment's classification.

Rule: a production + active equipment must have exactly one ACTIVE Machine (kiosk);
auxiliary or inactive equipment must not. We soft-toggle `is_active` instead of
deleting, so MES history (stops, operators, production logs) survives a round-trip
production → auxiliary → production.

Call `ensure_machine_for_equipment(db, eq)` right before committing in the equipment
create/update/delete endpoints. The caller owns the commit.
"""
import re
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Machine, Equipment, MachineStatus

_EQ_TO_MACHINE_STATUS = {
    "running": MachineStatus.running,
    "in_maintenance": MachineStatus.maintenance,
    "stopped": MachineStatus.stopped,
    "scrapped": MachineStatus.idle,
}


def _slugify(value: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (value or "").lower()).strip("-")
    return s or "machine"


async def _unique_slug(db: AsyncSession, base: str) -> str:
    slug, i = base, 2
    while (await db.execute(select(Machine.id).where(Machine.page_slug == slug))).first() is not None:
        slug = f"{base}-{i}"
        i += 1
    return slug


async def ensure_machine_for_equipment(db: AsyncSession, eq: Equipment) -> None:
    existing = (
        await db.execute(select(Machine).where(Machine.equipment_id == eq.id))
    ).scalars().first()

    want_kiosk = (eq.asset_type == "production") and bool(eq.active)

    if want_kiosk:
        if existing:
            # keep the kiosk; reactivate if it had been turned off, refresh the link fields
            existing.is_active = True
            existing.plant_id = eq.plant_id
            # keep the kiosk name in sync with the equipment (display_name overrides it in the UI)
            existing.name = (eq.name or eq.code or "Machine")[:200]
            if not existing.page_slug:
                existing.page_slug = await _unique_slug(db, _slugify(eq.code or eq.name))
            return
        base = _slugify(eq.code or eq.name)
        slug = await _unique_slug(db, base)
        # Machine.code is unique → only carry the equipment code over if it's free
        code = eq.code
        if code and (await db.execute(select(Machine.id).where(Machine.code == code))).first() is not None:
            code = None
        status = _EQ_TO_MACHINE_STATUS.get(eq.status.value if eq.status else "running", MachineStatus.running)
        db.add(Machine(
            name=(eq.name or eq.code or "Machine")[:200],
            code=code,
            equipment_id=eq.id,
            plant_id=eq.plant_id,
            department=eq.department,
            location=eq.location,
            page_slug=slug,
            current_status=status,
            is_active=True,
        ))
    else:
        # not production (or deactivated) → the kiosk must be off
        if existing and existing.is_active:
            existing.is_active = False
