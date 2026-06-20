"""Escalation settings, contacts per level, notification log and SMS test."""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.permissions import require_role
from app.db.session import get_db
from app.models.models import (
    EscalationContact, NotificationLog, User, UserRole,
)
from app.services.notification_service import (
    NotificationService, get_escalation_settings, twilio_configured,
)

router = APIRouter()

# Configuration changes are for supervisors and above (admin always passes)
require_supervisor = require_role(
    UserRole.supervisor, UserRole.maintenance_director,
    UserRole.plant_manager, UserRole.director,
)

SETTINGS_FIELDS = [
    "sla_critical_minutes", "sla_high_minutes", "sla_medium_minutes", "sla_low_minutes",
    "max_escalation_level", "sms_enabled", "email_enabled",
    "notify_on_critical_alert", "notify_on_ticket_assigned", "notify_on_pm_overdue",
    "notify_on_ticket_opened", "notify_on_ticket_completed",
    "technician_self_assign",
]


def _settings_out(row) -> dict:
    out = {f: getattr(row, f) for f in SETTINGS_FIELDS}
    out["twilio_configured"] = twilio_configured()
    return out


def _contact_out(c: EscalationContact, u: User) -> dict:
    return {
        "id": str(c.id),
        "level": c.level,
        "user_id": str(c.user_id),
        "user_name": u.name,
        "user_phone": u.phone,
        "user_email": u.email,
        "via_sms": c.via_sms,
        "via_email": c.via_email,
        "is_active": c.is_active,
    }


async def _all_contacts(db: AsyncSession) -> list[dict]:
    rows = (await db.execute(
        select(EscalationContact, User)
        .join(User, EscalationContact.user_id == User.id)
        .order_by(EscalationContact.level, User.name)
    )).all()
    return [_contact_out(c, u) for c, u in rows]


@router.get("/settings")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    row = await get_escalation_settings(db)
    await db.commit()
    return {"settings": _settings_out(row), "contacts": await _all_contacts(db)}


@router.patch("/settings")
async def update_settings(
    body: dict,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_supervisor),
):
    row = await get_escalation_settings(db)
    for f in SETTINGS_FIELDS:
        if f in body and body[f] is not None:
            setattr(row, f, body[f])
    await db.commit()
    return _settings_out(row)


class ContactCreate(BaseModel):
    level: int
    user_id: UUID
    via_sms: bool = True
    via_email: bool = True


@router.post("/contacts", status_code=201)
async def add_contact(
    data: ContactCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_supervisor),
):
    # Level 0 = ticket open/close notification group; 1..5 = escalation levels
    if not 0 <= data.level <= 5:
        raise HTTPException(422, "level must be between 0 and 5")
    user = await db.get(User, data.user_id)
    if not user:
        raise HTTPException(404, "User not found")
    existing = (await db.execute(
        select(EscalationContact).where(
            EscalationContact.level == data.level,
            EscalationContact.user_id == data.user_id,
        )
    )).scalar_one_or_none()
    if existing:
        existing.is_active = True
        existing.via_sms = data.via_sms
        existing.via_email = data.via_email
        await db.commit()
        return _contact_out(existing, user)
    contact = EscalationContact(
        level=data.level, user_id=data.user_id,
        via_sms=data.via_sms, via_email=data.via_email,
    )
    db.add(contact)
    await db.commit()
    await db.refresh(contact)
    return _contact_out(contact, user)


class ContactPatch(BaseModel):
    via_sms: Optional[bool] = None
    via_email: Optional[bool] = None
    is_active: Optional[bool] = None
    level: Optional[int] = None


@router.patch("/contacts/{contact_id}")
async def update_contact(
    contact_id: UUID,
    data: ContactPatch,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_supervisor),
):
    contact = await db.get(EscalationContact, contact_id)
    if not contact:
        raise HTTPException(404, "Contact not found")
    for k, v in data.model_dump(exclude_none=True).items():
        setattr(contact, k, v)
    await db.commit()
    user = await db.get(User, contact.user_id)
    return _contact_out(contact, user)


@router.delete("/contacts/{contact_id}", status_code=204)
async def delete_contact(
    contact_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_supervisor),
):
    contact = await db.get(EscalationContact, contact_id)
    if not contact:
        raise HTTPException(404, "Contact not found")
    await db.delete(contact)
    await db.commit()


@router.get("/notifications")
async def list_notifications(
    limit: int = Query(50, le=200),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = (await db.execute(
        select(NotificationLog).order_by(NotificationLog.created_at.desc()).limit(limit)
    )).scalars().all()
    return [
        {
            "id": str(n.id),
            "type": n.notification_type,
            "recipient_role": n.recipient_role,
            "recipient_name": n.recipient_name,
            "recipient_contact": n.recipient_contact,
            "message": n.message,
            "status": n.status,
            "created_at": n.created_at.isoformat() if n.created_at else None,
        }
        for n in rows
    ]


class TestSmsBody(BaseModel):
    phone: Optional[str] = None


@router.post("/test-sms")
async def test_sms(
    body: TestSmsBody,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_supervisor),
):
    phone = body.phone or current_user.phone
    if not phone:
        raise HTTPException(422, "No phone number — provide one or set it on your profile")
    notif = NotificationService(db)
    status = await notif.send_sms(
        recipient=phone,
        message=f"[MES] Test SMS — escalation module is configured. ({current_user.name})",
        recipient_role="test",
        recipient_name=current_user.name,
    )
    await db.commit()
    return {"status": status, "twilio_configured": twilio_configured(), "phone": phone}
