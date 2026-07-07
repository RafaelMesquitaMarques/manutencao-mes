"""
Notification service — SMS via Twilio (simulation mode when credentials are
unset), email/Teams still mocked. Every send is recorded in notification_logs.

Escalation recipients come from the escalation_contacts table (configured in
Settings → Escalation); when a level has no contacts, falls back to active
users with the matching role.
"""
import asyncio
import logging
from datetime import datetime
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings as app_settings
from app.models.models import (
    EscalationContact, EscalationSettings, Machine, MaintenanceAlert,
    NotificationLog, Plant, Technician, User, UserRole,
)

logger = logging.getLogger(__name__)

DEFAULT_TZ = "America/Toronto"
PRIORITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# SMS text per notification type. Overridable in Settings → Escalation
# (escalation_settings.sms_templates); empty/missing key = this default.
# Variables: {number} {machine} {priority} {description} {level}
TEMPLATE_DEFAULTS = {
    "escalation":          "[MES] N{level} {number} ({priority}) — {machine}: {description}",
    "escalation_reminder": "[MES] RAPPEL N{level} {number} ({priority}) — {machine}: {description}",
    "critical_alert":      "[MES] CRITIQUE {number} — {machine}: {description}",
    "ticket_opened":       "[MES] Nouveau ticket {number} — {machine} ({priority}): {description}",
    "ticket_completed":    "[MES] Ticket {number} terminé — {machine}",
    "ticket_assigned":     "[MES] Ticket {number} assigné — {machine} ({priority}): {description}",
    "claimable_tech":      "[MES] Ticket à prendre {number} — {machine} ({priority}). Ouvrez Mon travail.",
}


class _SafeDict(dict):
    """format_map helper — unknown {placeholders} render as empty."""
    def __missing__(self, key):
        return ""


def render_sms_template(esc, key: str, **vars) -> str:
    """Custom template when set, default otherwise; a broken custom template
    (unbalanced braces…) falls back to the default rather than dropping the SMS."""
    custom = ((getattr(esc, "sms_templates", None) or {}).get(key) or "").strip()
    for tpl in ([custom] if custom else []) + [TEMPLATE_DEFAULTS[key]]:
        try:
            return tpl.format_map(_SafeDict(**vars)).strip()
        except (ValueError, IndexError, KeyError):
            logger.warning("[SMS] Bad template for %r — using default", key)
    return TEMPLATE_DEFAULTS[key]


def channel_enabled(esc, trigger: str, channel: str) -> bool:
    """Per-trigger channel matrix; missing entry = enabled."""
    row = (getattr(esc, "channel_matrix", None) or {}).get(trigger) or {}
    value = row.get(channel)
    return True if value is None else bool(value)


def _priority_str(p) -> str:
    return p.value if hasattr(p, "value") else str(p or "")


def _parse_hhmm(s: Optional[str]) -> Optional[int]:
    """'HH:MM' → minutes since midnight; None when unset/garbage."""
    if not s:
        return None
    try:
        h, m = s.split(":")
        return int(h) * 60 + int(m)
    except (ValueError, AttributeError):
        return None


def _in_notify_window(start: Optional[str], end: Optional[str], now_min: int) -> bool:
    """Quiet-hours check. Missing/equal bounds = always on duty; start > end
    means the window wraps past midnight (e.g. 22:00–06:00)."""
    s, e = _parse_hhmm(start), _parse_hhmm(end)
    if s is None or e is None or s == e:
        return True
    if s < e:
        return s <= now_min < e
    return now_min >= s or now_min < e

# Fallback when no contacts are configured for a level
LEVEL_FALLBACK_ROLES = {
    1: UserRole.supervisor,
    2: UserRole.maintenance_director,
    3: UserRole.plant_manager,
}

# Claimable-ticket pings to the technician pool are throttled to cut SMS cost/noise:
# only these priorities blast the pool, and only technicians on the ticket's shift
# (+ rotating) are pinged. Lower priorities stay claimable in My Work without an SMS.
CLAIMABLE_MIN_PRIORITIES = {"high", "critical"}
ALERT_TO_TECH_SHIFT = {"morning": "day", "afternoon": "evening", "night": "night"}


async def get_escalation_settings(db: AsyncSession) -> EscalationSettings:
    """Get-or-create the singleton settings row."""
    row = (await db.execute(select(EscalationSettings).limit(1))).scalar_one_or_none()
    if not row:
        row = EscalationSettings()
        db.add(row)
        await db.flush()
    return row


def twilio_configured() -> bool:
    return bool(
        app_settings.TWILIO_ACCOUNT_SID
        and app_settings.TWILIO_AUTH_TOKEN
        and app_settings.TWILIO_FROM_NUMBER
    )


def _twilio_send(to: str, body: str) -> str:
    """Blocking Twilio call — run via asyncio.to_thread. Returns the message SID."""
    from twilio.rest import Client

    client = Client(app_settings.TWILIO_ACCOUNT_SID, app_settings.TWILIO_AUTH_TOKEN)
    msg = client.messages.create(
        to=to,
        from_=app_settings.TWILIO_FROM_NUMBER,
        body=body,
    )
    return msg.sid


class NotificationService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def send_email(
        self,
        recipient: str,
        subject: str,
        body: str,
        alert_id: Optional[UUID] = None,
        ticket_id: Optional[UUID] = None,
        recipient_role: Optional[str] = None,
        recipient_name: Optional[str] = None,
    ) -> None:
        # Replace with nodemailer / SMTP SDK call here
        logger.info("[EMAIL MOCK] To: %s | Subject: %s", recipient, subject)
        self.db.add(NotificationLog(
            alert_id=alert_id,
            ticket_id=ticket_id,
            notification_type="email",
            recipient_role=recipient_role,
            recipient_name=recipient_name,
            recipient_contact=recipient,
            message=f"{subject}\n{body}",
            status="simulated",
        ))
        await self.db.flush()

    async def send_sms(
        self,
        recipient: str,
        message: str,
        alert_id: Optional[UUID] = None,
        ticket_id: Optional[UUID] = None,
        recipient_role: Optional[str] = None,
        recipient_name: Optional[str] = None,
    ) -> str:
        """Send an SMS via Twilio; simulation mode when credentials are unset.
        Returns the resulting status (sent | simulated | failed)."""
        status = "simulated"
        detail = ""
        if twilio_configured():
            try:
                sid = await asyncio.to_thread(_twilio_send, recipient, message)
                status = "sent"
                detail = f" [twilio:{sid}]"
            except Exception as exc:
                status = "failed"
                detail = f" [error: {str(exc)[:300]}]"
                logger.error("[SMS] Twilio send failed to %s: %s", recipient, exc)
        else:
            logger.info("[SMS SIMULATED] To: %s | %s", recipient, message[:80])

        self.db.add(NotificationLog(
            alert_id=alert_id,
            ticket_id=ticket_id,
            notification_type="sms",
            recipient_role=recipient_role,
            recipient_name=recipient_name,
            recipient_contact=recipient,
            message=message + detail,
            status=status,
        ))
        await self.db.flush()
        return status

    async def send_teams(
        self,
        recipient: str,
        message: str,
        alert_id: Optional[UUID] = None,
        ticket_id: Optional[UUID] = None,
        recipient_role: Optional[str] = None,
        recipient_name: Optional[str] = None,
    ) -> None:
        # Replace with Teams webhook POST call here
        logger.info("[TEAMS MOCK] To: %s | %s", recipient, message[:80])
        self.db.add(NotificationLog(
            alert_id=alert_id,
            ticket_id=ticket_id,
            notification_type="teams",
            recipient_role=recipient_role,
            recipient_name=recipient_name,
            recipient_contact=recipient,
            message=message,
            status="simulated",
        ))
        await self.db.flush()

    # ── Recipient resolution ─────────────────────────────────────────────────

    async def _local_now_minutes(self, machine: Optional[Machine]) -> int:
        """Minutes since midnight in the plant's timezone (falls back to the
        default when the machine has no plant or the tz name is invalid)."""
        tz_name = None
        if machine is not None and machine.plant_id:
            tz_name = (await self.db.execute(
                select(Plant.timezone).where(Plant.id == machine.plant_id)
            )).scalar_one_or_none()
        try:
            tz = ZoneInfo(tz_name or DEFAULT_TZ)
        except Exception:
            tz = ZoneInfo(DEFAULT_TZ)
        now = datetime.now(tz)
        return now.hour * 60 + now.minute

    @staticmethod
    def _contact_in_scope(c: EscalationContact, machine: Optional[Machine]) -> bool:
        """Unscoped contact = whole factory. A scoped contact only matches its
        machines/department — so it never matches when the event has no machine."""
        ids = c.scope_machine_ids or []
        if ids:
            return machine is not None and str(machine.id) in {str(i) for i in ids}
        dept = (c.scope_department or "").strip()
        if dept:
            return machine is not None and (machine.department or "").strip().lower() == dept.lower()
        return True

    @staticmethod
    def _contact_on_duty(c: EscalationContact, priority: str, now_min: int) -> bool:
        if priority == "critical" and (c.critical_bypass is None or c.critical_bypass):
            return True
        return _in_notify_window(c.notify_start, c.notify_end, now_min)

    async def _level_recipients(
        self,
        level: int,
        machine: Optional[Machine] = None,
        priority=None,
    ) -> list[dict]:
        """Configured contacts for a level, filtered by machine scope and quiet
        hours; falls back to users by role when nobody matches."""
        rows = (await self.db.execute(
            select(EscalationContact, User)
            .join(User, EscalationContact.user_id == User.id)
            .where(
                EscalationContact.level == level,
                EscalationContact.is_active == True,
                User.active == True,
            )
        )).all()
        if rows:
            now_min = await self._local_now_minutes(machine)
            pr = _priority_str(priority)
            matched = [
                (c, u) for c, u in rows
                if self._contact_in_scope(c, machine) and self._contact_on_duty(c, pr, now_min)
            ]
            if matched:
                return [
                    {"user": u, "via_sms": c.via_sms, "via_email": c.via_email}
                    for c, u in matched
                ]
            logger.info(
                "[ESCALATION] L%s has contacts but none match scope/schedule — role fallback",
                level,
            )
        role = LEVEL_FALLBACK_ROLES.get(level)
        if not role:
            return []
        users = (await self.db.execute(
            select(User).where(User.role == role, User.active == True)
        )).scalars().all()
        return [{"user": u, "via_sms": True, "via_email": True} for u in users]

    async def _dispatch(
        self,
        recipients: list[dict],
        esc: EscalationSettings,
        subject: str,
        body: str,
        sms_text: str,
        role_label: str,
        alert_id: Optional[UUID] = None,
        ticket_id: Optional[UUID] = None,
        trigger: Optional[str] = None,
    ) -> None:
        sms_on = esc.sms_enabled and (trigger is None or channel_enabled(esc, trigger, "sms"))
        email_on = esc.email_enabled and (trigger is None or channel_enabled(esc, trigger, "email"))
        for r in recipients:
            user = r["user"]
            if sms_on and r["via_sms"] and user.phone:
                await self.send_sms(
                    recipient=user.phone, message=sms_text,
                    alert_id=alert_id, ticket_id=ticket_id,
                    recipient_role=role_label, recipient_name=user.name,
                )
            if email_on and r["via_email"] and user.email:
                await self.send_email(
                    recipient=user.email, subject=subject, body=body,
                    alert_id=alert_id, ticket_id=ticket_id,
                    recipient_role=role_label, recipient_name=user.name,
                )

    # ── Event notifications ──────────────────────────────────────────────────

    async def send_escalation(self, level: int, alert, reminder: bool = False) -> None:
        esc = await get_escalation_settings(self.db)
        machine = await self.db.get(Machine, alert.machine_id) if alert.machine_id else None
        recipients = await self._level_recipients(level, machine=machine, priority=alert.priority)
        if not recipients:
            logger.warning("[ESCALATION] No recipients for level %s", level)
            return
        tag = "Reminder" if reminder else "Escalation"
        subject = f"[MES] {tag} L{level}: {alert.alert_number}"
        body = (
            f"{tag} Level {level}\n"
            f"Alert: {alert.alert_number}\n"
            f"Priority: {alert.priority}\n"
            f"Problem: {alert.description or 'N/A'}\n"
            f"Open since: {alert.created_at.isoformat()}"
        )
        sms_text = render_sms_template(
            esc, "escalation_reminder" if reminder else "escalation",
            level=level, number=alert.alert_number,
            priority=_priority_str(alert.priority),
            machine=machine.name if machine else "—",
            description=(alert.description or "alerte ouverte")[:100],
        )
        role_label = f"escalation_l{level}" + ("_reminder" if reminder else "")
        await self._dispatch(
            recipients, esc, subject, body, sms_text,
            role_label=role_label, alert_id=alert.id, trigger="escalation",
        )

    async def notify_new_critical(
        self,
        *,
        ref_number: str,
        description: Optional[str],
        machine_name: Optional[str] = None,
        alert_id: Optional[UUID] = None,
        ticket_id: Optional[UUID] = None,
        machine: Optional[Machine] = None,
    ) -> None:
        """Immediate notification to level-1 contacts when a critical
        alert/ticket is created (no SLA wait)."""
        esc = await get_escalation_settings(self.db)
        if not esc.notify_on_critical_alert:
            return
        recipients = await self._level_recipients(1, machine=machine, priority="critical")
        if not recipients:
            return
        where = f" — {machine_name}" if machine_name else ""
        subject = f"[MES] CRITICAL: {ref_number}{where}"
        body = f"Critical alert {ref_number}{where}\n{description or ''}"
        sms_text = render_sms_template(
            esc, "critical_alert",
            number=ref_number, machine=machine_name or "—",
            priority="critical", description=(description or "")[:100],
        )
        await self._dispatch(
            recipients, esc, subject, body, sms_text,
            role_label="critical_alert", alert_id=alert_id, ticket_id=ticket_id,
            trigger="critical_alert",
        )

    @staticmethod
    def _meets_group_min_priority(esc: EscalationSettings, priority) -> bool:
        """Level-0 ticket group filter: skip tickets below the configured floor."""
        floor = getattr(esc, "ticket_group_min_priority", None) or "low"
        return PRIORITY_RANK.get(_priority_str(priority), 1) >= PRIORITY_RANK.get(floor, 0)

    async def _already_sent(self, ticket_id, role_marker: str) -> bool:
        r = await self.db.execute(
            select(NotificationLog.id).where(
                NotificationLog.ticket_id == ticket_id,
                NotificationLog.recipient_role == role_marker,
            ).limit(1)
        )
        return r.first() is not None

    async def notify_claimable_to_technicians(self, ticket, machine_name: Optional[str]) -> None:
        """When self-assignment is ON, alert the technician pool that a new
        unassigned ticket is up for grabs. Throttled to cut SMS cost/noise: only
        high/critical tickets blast, and only technicians on the ticket's shift
        (+ rotating) are pinged. When self-assign is OFF, a supervisor dispatches
        the work, so nobody is pinged here — mirrors the technician_self_assign
        rule enforced on POST /tickets/{id}/claim."""
        esc = await get_escalation_settings(self.db)
        if not esc.technician_self_assign:
            return
        if ticket.assigned_to_id:                       # already taken / dispatched
            return
        if await self._already_sent(ticket.id, "claimable_tech"):
            return
        # Throttle by priority: lower priorities stay claimable in My Work, no SMS blast.
        pr = ticket.priority.value if hasattr(ticket.priority, "value") else str(ticket.priority or "")
        if pr not in CLAIMABLE_MIN_PRIORITIES:
            return
        # Restrict to the ticket's shift (from the linked alert) + rotating techs;
        # unknown shift → everyone. rotating/shift-less techs are always eligible.
        target_shift = None
        if ticket.alert_id:
            alert = await self.db.get(MaintenanceAlert, ticket.alert_id)
            if alert and alert.shift is not None:
                ashift = alert.shift.value if hasattr(alert.shift, "value") else str(alert.shift)
                target_shift = ALERT_TO_TECH_SHIFT.get(ashift)
        rows = (await self.db.execute(
            select(User, Technician.shift)
            .join(Technician, Technician.user_id == User.id)
            .where(Technician.active == True, User.active == True)
        )).all()

        def _on_shift(tshift) -> bool:
            if target_shift is None or tshift is None:
                return True
            ts = tshift.value if hasattr(tshift, "value") else str(tshift)
            return ts in (target_shift, "rotating")

        recipients = [u for (u, tshift) in rows if _on_shift(tshift)]
        if not recipients and rows:            # never leave high/critical work unannounced
            recipients = [u for (u, _t) in rows]
        if not recipients:
            return
        where = machine_name or "Machine"
        subject = f"[MES] Ticket à prendre {ticket.ticket_number} — {where}"
        body = (
            f"Nouveau ticket disponible: {ticket.ticket_number}\n"
            f"Machine: {where}\n"
            f"Priorité: {pr}\n"
            f"{ticket.description or ''}\n"
            f"Ouvrez Mon travail pour le prendre."
        )
        sms_text = render_sms_template(
            esc, "claimable_tech",
            number=ticket.ticket_number, machine=where,
            priority=pr, description=(ticket.description or "")[:90],
        )
        sms_on = esc.sms_enabled and channel_enabled(esc, "claimable_tech", "sms")
        email_on = esc.email_enabled and channel_enabled(esc, "claimable_tech", "email")
        for u in recipients:
            if sms_on and u.phone:
                await self.send_sms(
                    recipient=u.phone, message=sms_text, ticket_id=ticket.id,
                    recipient_role="claimable_tech", recipient_name=u.name,
                )
            if email_on and u.email:
                await self.send_email(
                    recipient=u.email, subject=subject, body=body, ticket_id=ticket.id,
                    recipient_role="claimable_tech", recipient_name=u.name,
                )

    async def notify_ticket_opened(self, ticket, machine_name: Optional[str]) -> None:
        """Every new ticket → SMS/email to the level-0 contact group, plus the
        technician pool when self-assignment is on (independent of the toggle below)."""
        await self.notify_claimable_to_technicians(ticket, machine_name)
        esc = await get_escalation_settings(self.db)
        if not esc.notify_on_ticket_opened:
            return
        if not self._meets_group_min_priority(esc, ticket.priority):
            return
        if await self._already_sent(ticket.id, "ticket_opened"):
            return
        machine = await self.db.get(Machine, ticket.machine_id) if ticket.machine_id else None
        recipients = await self._level_recipients(0, machine=machine, priority=ticket.priority)
        if not recipients:
            return
        where = machine_name or "Machine"
        subject = f"[MES] Nouveau ticket {ticket.ticket_number} — {where}"
        body = (
            f"Ticket: {ticket.ticket_number}\n"
            f"Machine: {where}\n"
            f"Priority: {ticket.priority}\n"
            f"{ticket.description or ''}"
        )
        sms_text = render_sms_template(
            esc, "ticket_opened",
            number=ticket.ticket_number, machine=where,
            priority=_priority_str(ticket.priority),
            description=(ticket.description or "")[:90],
        )
        await self._dispatch(
            recipients, esc, subject, body, sms_text,
            role_label="ticket_opened", ticket_id=ticket.id, trigger="ticket_opened",
        )

    async def notify_ticket_completed(self, ticket, machine_name: Optional[str]) -> None:
        """Ticket closed → SMS/email to the level-0 contact group (once)."""
        esc = await get_escalation_settings(self.db)
        if not esc.notify_on_ticket_completed:
            return
        if not self._meets_group_min_priority(esc, ticket.priority):
            return
        if await self._already_sent(ticket.id, "ticket_closed"):
            return
        machine = await self.db.get(Machine, ticket.machine_id) if ticket.machine_id else None
        recipients = await self._level_recipients(0, machine=machine, priority=ticket.priority)
        if not recipients:
            return
        where = machine_name or "Machine"
        subject = f"[MES] Ticket {ticket.ticket_number} terminé — {where}"
        body = (
            f"Ticket: {ticket.ticket_number}\n"
            f"Machine: {where}\n"
            f"Diagnostic: {ticket.diagnosis or '—'}\n"
            f"Action: {ticket.corrective_action or '—'}"
        )
        sms_text = render_sms_template(
            esc, "ticket_completed",
            number=ticket.ticket_number, machine=where,
            priority=_priority_str(ticket.priority),
            description=(ticket.description or "")[:90],
        )
        await self._dispatch(
            recipients, esc, subject, body, sms_text,
            role_label="ticket_closed", ticket_id=ticket.id, trigger="ticket_completed",
        )

    async def notify_ticket_assigned(self, ticket, user: User, machine_name: str) -> None:
        """Notify the technician when a ticket is assigned to them."""
        esc = await get_escalation_settings(self.db)
        if not esc.notify_on_ticket_assigned:
            return
        subject = f"[MES] Ticket {ticket.ticket_number} assigned to you"
        body = (
            f"Ticket: {ticket.ticket_number}\n"
            f"Machine: {machine_name}\n"
            f"Priority: {ticket.priority}\n"
            f"{ticket.description or ''}"
        )
        sms_text = render_sms_template(
            esc, "ticket_assigned",
            number=ticket.ticket_number, machine=machine_name,
            priority=_priority_str(ticket.priority),
            description=(ticket.description or "")[:80],
        )
        if esc.sms_enabled and channel_enabled(esc, "ticket_assigned", "sms") and user.phone:
            await self.send_sms(
                recipient=user.phone, message=sms_text,
                ticket_id=ticket.id, recipient_role="technician", recipient_name=user.name,
            )
        if esc.email_enabled and channel_enabled(esc, "ticket_assigned", "email") and user.email:
            await self.send_email(
                recipient=user.email, subject=subject, body=body,
                ticket_id=ticket.id, recipient_role="technician", recipient_name=user.name,
            )
