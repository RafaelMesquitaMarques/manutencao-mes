"""Escalation settings, contacts per level, notification log and SMS test."""
import re
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import get_current_user
from app.core.permissions import require_role
from app.core.plant_context import PlantContext, get_plant_context
from app.db.session import get_db
from app.models.models import (
    EscalationContact, MaintenanceAlert, MaintenanceTicket, NotificationLog,
    User, UserPlant, UserRole,
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
    "technician_self_assign", "shift_report_enabled", "ticket_group_min_priority",
    "reminder_minutes", "pause_during_planned_stop",
    "sms_templates", "channel_matrix",
    "teams_enabled", "teams_webhook_url",
]

VALID_PRIORITIES = {"low", "medium", "high", "critical"}


def _validate_hhmm(value: Optional[str], field: str) -> None:
    if value is None or value == "":
        return
    parts = value.split(":")
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        raise HTTPException(422, f"{field} must be HH:MM")
    h, m = int(parts[0]), int(parts[1])
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise HTTPException(422, f"{field} must be HH:MM")


def _settings_out(row) -> dict:
    from app.services.notification_service import TEMPLATE_DEFAULTS
    out = {f: getattr(row, f) for f in SETTINGS_FIELDS}
    out["sms_templates"] = out.get("sms_templates") or {}
    out["channel_matrix"] = out.get("channel_matrix") or {}
    out["sms_template_defaults"] = TEMPLATE_DEFAULTS
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
        "scope_department": c.scope_department,
        "scope_machine_ids": c.scope_machine_ids or [],
        "notify_start": c.notify_start,
        "notify_end": c.notify_end,
        "critical_bypass": c.critical_bypass if c.critical_bypass is not None else True,
    }


def _contact_visible(plant_id):
    """Contacts relevant to a plant — the SAME rule the sender uses in
    notification_service._level_recipients: an explicit per-plant contact, or a
    shared (plant_id NULL) contact whose user holds a membership in that plant."""
    return or_(
        EscalationContact.plant_id == plant_id,
        and_(
            EscalationContact.plant_id.is_(None),
            exists(select(UserPlant.id).where(
                UserPlant.user_id == EscalationContact.user_id,
                UserPlant.plant_id == plant_id,
            )),
        ),
    )


async def _load_visible_contact(contact_id, db: AsyncSession, ctx: PlantContext) -> EscalationContact:
    """A contact the caller may edit: visible for the active plant, else 404."""
    contact = await db.get(EscalationContact, contact_id)
    if contact is not None:
        seen = (await db.execute(
            select(EscalationContact.id).where(
                EscalationContact.id == contact_id, _contact_visible(ctx.plant_id)
            )
        )).first()
        if seen is not None:
            return contact
    raise HTTPException(404, "Contact not found")


async def _all_contacts(db: AsyncSession, ctx: PlantContext) -> list[dict]:
    rows = (await db.execute(
        select(EscalationContact, User)
        .join(User, EscalationContact.user_id == User.id)
        .where(_contact_visible(ctx.plant_id))
        .order_by(EscalationContact.level, User.name)
    )).all()
    return [_contact_out(c, u) for c, u in rows]


@router.get("/settings")
async def get_settings(
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    # Per-plant settings (QS+QM share the legacy NULL row; NL owns its own), and
    # only the contacts relevant to the active plant.
    row = await get_escalation_settings(db, ctx.plant_id)
    await db.commit()
    return {"settings": _settings_out(row), "contacts": await _all_contacts(db, ctx)}


@router.patch("/settings")
async def update_settings(
    body: dict,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(require_supervisor),
):
    if body.get("ticket_group_min_priority") is not None \
            and body["ticket_group_min_priority"] not in VALID_PRIORITIES:
        raise HTTPException(422, "ticket_group_min_priority must be low|medium|high|critical")
    for f in ("sms_templates", "channel_matrix"):
        if body.get(f) is not None and not isinstance(body[f], dict):
            raise HTTPException(422, f"{f} must be an object")
    if body.get("teams_webhook_url"):
        url = str(body["teams_webhook_url"]).strip()
        if not url.lower().startswith("https://"):
            raise HTTPException(422, "invalid_teams_webhook_url")
        body["teams_webhook_url"] = url
    row = await get_escalation_settings(db, ctx.plant_id)
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
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(require_supervisor),
):
    # Level 0 = ticket open/close notification group; 1..5 = escalation levels
    if not 0 <= data.level <= 5:
        raise HTTPException(422, "level must be between 0 and 5")
    user = await db.get(User, data.user_id)
    if not user:
        raise HTTPException(404, "User not found")
    # Only add contacts for users who belong to the active plant (a QS supervisor
    # can't wire an NL user into notifications).
    member = (await db.execute(
        select(UserPlant.id).where(UserPlant.user_id == data.user_id, UserPlant.plant_id == ctx.plant_id)
    )).first()
    if member is None:
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
    scope_department: Optional[str] = None
    scope_machine_ids: Optional[list[str]] = None
    notify_start: Optional[str] = None
    notify_end: Optional[str] = None
    critical_bypass: Optional[bool] = None


@router.patch("/contacts/{contact_id}")
async def update_contact(
    contact_id: UUID,
    data: ContactPatch,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(require_supervisor),
):
    contact = await _load_visible_contact(contact_id, db, ctx)
    # exclude_unset (not exclude_none): an explicit null clears scope/schedule
    changes = data.model_dump(exclude_unset=True)
    for f in ("notify_start", "notify_end"):
        if f in changes:
            _validate_hhmm(changes[f], f)
            changes[f] = changes[f] or None
    if "scope_department" in changes:
        changes["scope_department"] = (changes["scope_department"] or "").strip() or None
    if "scope_machine_ids" in changes:
        changes["scope_machine_ids"] = changes["scope_machine_ids"] or None
    for k, v in changes.items():
        setattr(contact, k, v)
    await db.commit()
    user = await db.get(User, contact.user_id)
    return _contact_out(contact, user)


@router.delete("/contacts/{contact_id}", status_code=204)
async def delete_contact(
    contact_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(require_supervisor),
):
    contact = await _load_visible_contact(contact_id, db, ctx)
    await db.delete(contact)
    await db.commit()


def _notification_out(n: NotificationLog) -> dict:
    return {
        "id": str(n.id),
        "type": n.notification_type,
        "recipient_role": n.recipient_role,
        "recipient_name": n.recipient_name,
        "recipient_contact": n.recipient_contact,
        "message": n.message,
        "status": n.status,
        "created_at": n.created_at.isoformat() if n.created_at else None,
    }


@router.get("/notifications")
async def list_notifications(
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(get_current_user),
):
    # Scope to the active plant via the notification's linked alert/ticket.
    # (Plant-less system messages — test SMS, shift reports — are not shown here.)
    conds = [or_(
        NotificationLog.alert_id.in_(
            select(MaintenanceAlert.id).where(MaintenanceAlert.plant_id == ctx.plant_id)
        ),
        NotificationLog.ticket_id.in_(
            select(MaintenanceTicket.id).where(MaintenanceTicket.plant_id == ctx.plant_id)
        ),
    )]
    if type:
        conds.append(NotificationLog.notification_type == type)
    if status:
        conds.append(NotificationLog.status == status)
    if q:
        like = f"%{q}%"
        conds.append(or_(
            NotificationLog.recipient_name.ilike(like),
            NotificationLog.recipient_contact.ilike(like),
            NotificationLog.message.ilike(like),
        ))
    total = (await db.execute(
        select(func.count(NotificationLog.id)).where(*conds)
    )).scalar() or 0
    rows = (await db.execute(
        select(NotificationLog).where(*conds)
        .order_by(NotificationLog.created_at.desc())
        .offset(offset).limit(limit)
    )).scalars().all()
    return {"total": total, "items": [_notification_out(n) for n in rows]}


# Twilio/error detail appended to the stored message — stripped before resending
RESEND_SUFFIX_RE = re.compile(r"\s*\[(?:twilio|error):[^\]]*\]\s*$")


@router.post("/notifications/{notification_id}/resend")
async def resend_notification(
    notification_id: UUID,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(require_supervisor),
):
    """Re-send an SMS from the log (typically a failed one) to the same number."""
    n = await db.get(NotificationLog, notification_id)
    if not n:
        raise HTTPException(404, "Notification not found")
    # Never resend across the plant boundary: the linked alert/ticket must be visible.
    linked_plant = None
    if n.alert_id and (a := await db.get(MaintenanceAlert, n.alert_id)) is not None:
        linked_plant = a.plant_id
    elif n.ticket_id and (t := await db.get(MaintenanceTicket, n.ticket_id)) is not None:
        linked_plant = t.plant_id
    if linked_plant is None or not ctx.can_access(linked_plant):
        raise HTTPException(404, "Notification not found")
    if n.notification_type != "sms":
        raise HTTPException(422, "only_sms_can_be_resent")
    if not n.recipient_contact:
        raise HTTPException(422, "no_recipient_phone")
    message = RESEND_SUFFIX_RE.sub("", n.message or "").strip()
    if not message:
        raise HTTPException(422, "empty_message")
    notif = NotificationService(db)
    new_status = await notif.send_sms(
        recipient=n.recipient_contact, message=message,
        alert_id=n.alert_id, ticket_id=n.ticket_id,
        recipient_role=n.recipient_role, recipient_name=n.recipient_name,
    )
    await db.commit()
    return {"status": new_status}


# ── Shift report (end-of-shift summary, template-based — no AI) ───────────────

@router.get("/shift-report/preview")
async def preview_shift_report(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Render the report for the most recently ended shift window, without sending."""
    from app.services import shift_report_service

    found = await shift_report_service.latest_ended_window(db)
    if not found:
        raise HTTPException(404, "no_shift_windows")
    key, ws, we, tz_name, machines = found
    data = await shift_report_service.build_report_data(db, machines, key, ws, we, tz_name)
    lang = (current_user.language or "en")[:2]
    return {
        "shift_key": key,
        "window_start": ws.isoformat(),
        "window_end": we.isoformat(),
        "machines_included": len(data["machines"]),
        "text": shift_report_service.render_report(data, lang),
    }


@router.post("/shift-report/test")
async def send_test_shift_report(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_supervisor),
):
    """Send the latest shift report by SMS to the requesting user only."""
    from app.services import shift_report_service

    if not current_user.phone:
        raise HTTPException(422, "no_phone_on_profile")
    found = await shift_report_service.latest_ended_window(db)
    if not found:
        raise HTTPException(404, "no_shift_windows")
    key, ws, we, tz_name, machines = found
    data = await shift_report_service.build_report_data(db, machines, key, ws, we, tz_name)
    lang = (current_user.language or "en")[:2]
    text = shift_report_service.render_report(data, lang)
    notif = NotificationService(db)
    status = await notif.send_sms(
        recipient=current_user.phone, message=text,
        recipient_role="shift_report_test", recipient_name=current_user.name,
    )
    await db.commit()
    return {"status": status, "twilio_configured": twilio_configured(), "text": text}


class TestTeamsBody(BaseModel):
    webhook_url: Optional[str] = None


@router.post("/test-teams")
async def test_teams(
    body: TestTeamsBody,
    db: AsyncSession = Depends(get_db),
    ctx: PlantContext = Depends(get_plant_context),
    current_user: User = Depends(require_supervisor),
):
    """Post a test Adaptive Card to the Teams channel webhook — the one in the
    body (not yet saved) or the plant's stored one."""
    esc = await get_escalation_settings(db, ctx.plant_id)
    url = (body.webhook_url or esc.teams_webhook_url or "").strip()
    if not url:
        raise HTTPException(422, "no_teams_webhook_url")
    if not url.lower().startswith("https://"):
        raise HTTPException(422, "invalid_teams_webhook_url")
    notif = NotificationService(db)
    status = await notif.send_teams(
        url,
        title="Test — KAIZO notifications",
        lines=[f"Configured by: {current_user.name}",
               "This channel will receive maintenance notifications."],
        recipient_role="test",
    )
    await db.commit()
    return {"status": status}


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
