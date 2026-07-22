"""
Notification service — SMS via Twilio (simulation mode when credentials are
unset), Microsoft Teams via a channel webhook (Adaptive Card per event), email
still mocked. Every send is recorded in notification_logs.

Escalation recipients come from the escalation_contacts table (configured in
Settings → Escalation); when a level has no contacts, falls back to active
users with the matching role. Teams is a GROUP channel: one post per event,
gated by teams_enabled + webhook URL + channel_matrix — contact scoping and
quiet hours don't apply to it.
"""
import asyncio
import logging
import re
from datetime import datetime
from typing import Optional
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx

from sqlalchemy import and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings as app_settings
from app.models.models import (
    EscalationContact, EscalationSettings, Machine, MaintenanceAlert,
    NotificationLog, Plant, Technician, User, UserPlant, UserRole,
)

logger = logging.getLogger(__name__)

DEFAULT_TZ = "America/Toronto"
PRIORITY_RANK = {"low": 0, "medium": 1, "high": 2, "critical": 3}

# SMS text per notification type. Overridable in Settings → Escalation
# (escalation_settings.sms_templates); empty/missing key = this default.
# Variables: {number} {machine} {priority} {description} {level}
# ({technician} additionally on ticket_completed — who closed the work)
TEMPLATE_DEFAULTS = {
    "escalation":          "[MES] N{level} {number} ({priority}) — {machine}: {description}",
    "escalation_reminder": "[MES] RAPPEL N{level} {number} ({priority}) — {machine}: {description}",
    "critical_alert":      "[MES] CRITIQUE {number} — {machine}: {description}",
    "ticket_opened":       "[MES] Nouveau ticket {number} — {machine} ({priority}): {description}",
    "ticket_completed":    "[MES] Ticket {number} terminé — {machine}",
    "ticket_assigned":     "[MES] Ticket {number} assigné — {machine} ({priority}): {description}",
    "claimable_tech":      "[MES] Ticket à prendre {number} — {machine} ({priority}). Ouvrez Mon travail.",
    "condition_alert":     "[MES] Capteur {severity} — {machine}: {metric} {value} {unit} (seuil {limit}){ticket}",
    "of_watch":            "[MES] OF {number} sans mouvement depuis {minutes} min — {location}",
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


def teams_channel_on(esc, trigger: Optional[str] = None, of: bool = False) -> str:
    """The webhook URL when the Teams channel should fire for this trigger,
    else empty string. OF (job-order) events pass of=True: they post to the
    dedicated OF channel when one is configured, sharing the machine channel
    otherwise. teams_enabled is the single master switch for both."""
    url = (getattr(esc, "teams_webhook_url", None) or "").strip()
    if of:
        url = (getattr(esc, "of_teams_webhook_url", None) or "").strip() or url
    if not (getattr(esc, "teams_enabled", False) and url):
        return ""
    if trigger is not None and not channel_enabled(esc, trigger, "teams"):
        return ""
    return url


# A report/body line "Key: Value" becomes an Adaptive Card fact — but only when
# the key looks like a label (starts with a letter), so times like "07:00-15:00"
# stay plain text.
_FACT_KEY_RE = re.compile(r"^[^\W\d_][\w \-/()'’.À-ÿ]{0,23}$")

# Trigger → title color of the Teams card (Adaptive Card semantic colors)
TEAMS_ACCENTS = {
    "critical_alert": "attention",
    "escalation": "attention",
    "condition_alert": "warning",
    "ticket_completed": "good",
    "of_watch": "warning",
}


def build_teams_payload(
    title: str,
    lines: list[str],
    link_url: Optional[str] = None,
    accent: str = "default",
    mono: bool = False,
) -> dict:
    """Adaptive Card inside the `message` envelope a Teams Workflows webhook
    expects ("When a Teams webhook request is received" → post to a channel).
    The legacy Office 365 connector format (MessageCard) is retired, so this is
    the only shape worth emitting. `mono` keeps pre-formatted text (shift
    report) aligned instead of folding lines into a fact table."""
    body: list[dict] = [{
        "type": "TextBlock", "size": "Medium", "weight": "Bolder",
        "text": title, "wrap": True,
        **({"color": accent} if accent != "default" else {}),
    }]
    if mono:
        body += [
            {"type": "TextBlock", "text": ln or " ", "wrap": True,
             "spacing": "None", "fontType": "Monospace"}
            for ln in lines
        ]
    else:
        facts, free = [], []
        for ln in lines:
            key, sep, value = ln.partition(":")
            if sep and value.strip() and _FACT_KEY_RE.match(key.strip()):
                facts.append({"title": f"{key.strip()}:", "value": value.strip()})
            elif ln.strip():
                free.append(ln.strip())
        if facts:
            body.append({"type": "FactSet", "facts": facts})
        body += [
            {"type": "TextBlock", "text": txt, "wrap": True, "isSubtle": True}
            for txt in free
        ]
    card: dict = {
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "type": "AdaptiveCard",
        "version": "1.4",
        "msteams": {"width": "Full"},
        "body": body,
    }
    if link_url:
        card["actions"] = [{"type": "Action.OpenUrl", "title": "Ouvrir dans KAIZO", "url": link_url}]
    return {
        "type": "message",
        "attachments": [{
            "contentType": "application/vnd.microsoft.card.adaptive",
            "content": card,
        }],
    }


def teams_link(ticket_id=None, alert_id=None) -> Optional[str]:
    """Deep link for the card's open button; None (no button) without a
    PUBLIC_BASE_URL — localhost links would be dead inside Teams."""
    base = (app_settings.PUBLIC_BASE_URL or "").strip().rstrip("/")
    if not base:
        return None
    if ticket_id:
        return f"{base}/tickets/{ticket_id}"
    if alert_id:
        return f"{base}/alerts/{alert_id}"
    return base


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


async def get_escalation_settings(db: AsyncSession, plant_id=None) -> EscalationSettings:
    """Settings for a plant: its own row when one exists, else the legacy/shared
    row (plant_id NULL — what QS+QM edit together today). Get-or-create the
    shared row. A plant that needs independent SLAs (Las Vegas) gets its own row
    at onboarding and stops following the shared one."""
    if plant_id is not None:
        row = (await db.execute(
            select(EscalationSettings).where(EscalationSettings.plant_id == plant_id).limit(1)
        )).scalar_one_or_none()
        if row:
            return row
    row = (await db.execute(
        select(EscalationSettings).where(EscalationSettings.plant_id.is_(None)).limit(1)
    )).scalar_one_or_none()
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
        webhook_url: str,
        title: str,
        lines: list[str],
        link_url: Optional[str] = None,
        accent: str = "default",
        mono: bool = False,
        alert_id: Optional[UUID] = None,
        ticket_id: Optional[UUID] = None,
        recipient_role: Optional[str] = None,
    ) -> str:
        """POST one Adaptive Card to a Teams channel webhook (Workflows URL).
        Returns the resulting status (sent | simulated | failed); never raises.
        The URL is a secret — logged nowhere, not even in notification_logs."""
        payload = build_teams_payload(title, lines, link_url=link_url, accent=accent, mono=mono)
        status, detail = "simulated", ""
        if webhook_url:
            try:
                async with httpx.AsyncClient(timeout=8.0) as client:
                    resp = await client.post(webhook_url, json=payload)
                if 200 <= resp.status_code < 300:
                    status = "sent"
                else:
                    status = "failed"
                    detail = f" [error: HTTP {resp.status_code} {resp.text[:200]}]"
                    logger.error("[TEAMS] webhook answered HTTP %s", resp.status_code)
            except Exception as exc:
                status = "failed"
                detail = f" [error: {str(exc)[:300]}]"
                logger.error("[TEAMS] webhook post failed: %s", exc)
        else:
            logger.info("[TEAMS SIMULATED] %s", title)

        self.db.add(NotificationLog(
            alert_id=alert_id,
            ticket_id=ticket_id,
            notification_type="teams",
            recipient_role=recipient_role,
            recipient_name="Teams",
            recipient_contact="channel",
            message="\n".join([title, *lines]) + detail,
            status=status,
        ))
        await self.db.flush()
        return status

    # ── Recipient resolution ─────────────────────────────────────────────────

    async def _plant_tz(self, machine: Optional[Machine]) -> ZoneInfo:
        """The plant's timezone (falls back to the default when the machine has
        no plant or the tz name is invalid)."""
        tz_name = None
        if machine is not None and machine.plant_id:
            tz_name = (await self.db.execute(
                select(Plant.timezone).where(Plant.id == machine.plant_id)
            )).scalar_one_or_none()
        try:
            return ZoneInfo(tz_name or DEFAULT_TZ)
        except Exception:
            return ZoneInfo(DEFAULT_TZ)

    async def _local_now_minutes(self, machine: Optional[Machine]) -> int:
        """Minutes since midnight in the plant's timezone."""
        now = datetime.now(await self._plant_tz(machine))
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
        plant_id=None,
    ) -> list[dict]:
        """Configured contacts for a level, filtered by machine scope and quiet
        hours; falls back to users by role when nobody matches.

        Plant rule: an explicit per-plant contact fires only for its plant; a
        legacy contact (plant_id NULL) fires only for plants its USER holds a
        membership in. The shared QS+QM team therefore keeps getting both
        plants' notifications, while a new plant (NL) notifies nobody until its
        own contacts/memberships exist."""
        if plant_id is None and machine is not None:
            plant_id = machine.plant_id
        conds = [
            EscalationContact.level == level,
            # The OF alerts group is a separate audience — never mixed in here
            or_(EscalationContact.category.is_(None), EscalationContact.category != "of"),
            EscalationContact.is_active == True,  # noqa: E712
            User.active == True,                  # noqa: E712
        ]
        if plant_id is not None:
            conds.append(or_(
                EscalationContact.plant_id == plant_id,
                and_(
                    EscalationContact.plant_id.is_(None),
                    exists(select(UserPlant.id).where(
                        UserPlant.user_id == EscalationContact.user_id,
                        UserPlant.plant_id == plant_id,
                    )),
                ),
            ))
        rows = (await self.db.execute(
            select(EscalationContact, User)
            .join(User, EscalationContact.user_id == User.id)
            .where(*conds)
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
        q = select(User).where(User.role == role, User.active == True)  # noqa: E712
        if plant_id is not None:
            q = q.join(UserPlant, UserPlant.user_id == User.id).where(UserPlant.plant_id == plant_id)
        users = (await self.db.execute(q)).scalars().all()
        return [{"user": u, "via_sms": True, "via_email": True} for u in users]

    async def _of_recipients(
        self, plant_id, machine: Optional[Machine] = None,
    ) -> list[dict]:
        """The OF alerts group (contacts with category='of'), same plant rule as
        _level_recipients, filtered by scope (against the OF's current machine
        when it has one) and quiet hours. No role fallback: an empty group means
        only the watch creator hears about it."""
        conds = [
            EscalationContact.category == "of",
            EscalationContact.is_active == True,  # noqa: E712
            User.active == True,                  # noqa: E712
        ]
        if plant_id is not None:
            conds.append(or_(
                EscalationContact.plant_id == plant_id,
                and_(
                    EscalationContact.plant_id.is_(None),
                    exists(select(UserPlant.id).where(
                        UserPlant.user_id == EscalationContact.user_id,
                        UserPlant.plant_id == plant_id,
                    )),
                ),
            ))
        rows = (await self.db.execute(
            select(EscalationContact, User)
            .join(User, EscalationContact.user_id == User.id)
            .where(*conds)
        )).all()
        if not rows:
            return []
        now_min = await self._local_now_minutes(machine)
        return [
            {"user": u, "via_sms": c.via_sms, "via_email": c.via_email}
            for c, u in rows
            if self._contact_in_scope(c, machine) and self._contact_on_duty(c, "", now_min)
        ]

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
        # Teams is a channel, not a person: one card per EVENT, outside the
        # recipient loop (contact scope/quiet-hours don't apply).
        teams_url = teams_channel_on(esc, trigger)
        if teams_url:
            await self.send_teams(
                teams_url,
                title=subject.removeprefix("[MES] "),
                lines=body.splitlines(),
                link_url=teams_link(ticket_id=ticket_id, alert_id=alert_id),
                accent=TEAMS_ACCENTS.get(trigger or "", "default"),
                alert_id=alert_id, ticket_id=ticket_id, recipient_role=role_label,
            )

    # ── Event notifications ──────────────────────────────────────────────────

    async def send_escalation(self, level: int, alert, reminder: bool = False) -> None:
        plant_id = getattr(alert, "plant_id", None)
        esc = await get_escalation_settings(self.db, plant_id)
        machine = await self.db.get(Machine, alert.machine_id) if alert.machine_id else None
        recipients = await self._level_recipients(level, machine=machine, priority=alert.priority, plant_id=plant_id)
        if not recipients:
            logger.warning("[ESCALATION] No recipients for level %s", level)
            return
        tag = "Rappel" if reminder else "Escalade"
        subject = f"[MES] {tag} N{level}: {alert.alert_number}"
        opened_local = "—"
        if alert.created_at:
            tz = await self._plant_tz(machine)
            opened_local = alert.created_at.astimezone(tz).strftime("%Y-%m-%d %H:%M")
        body = (
            f"Alerte: {alert.alert_number}\n"
            f"Machine: {machine.name if machine else '—'}\n"
            f"Priorité: {_priority_str(alert.priority)}\n"
            f"Problème: {alert.description or '—'}\n"
            f"Ouvert depuis: {opened_local}"
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
        plant_id = machine.plant_id if machine is not None else None
        esc = await get_escalation_settings(self.db, plant_id)
        if not esc.notify_on_critical_alert:
            return
        recipients = await self._level_recipients(1, machine=machine, priority="critical", plant_id=plant_id)
        if not recipients:
            return
        where = f" — {machine_name}" if machine_name else ""
        subject = f"[MES] CRITIQUE: {ref_number}{where}"
        body = (
            f"Alerte CRITIQUE: {ref_number}\n"
            f"Machine: {machine_name or '—'}\n"
            f"{description or ''}"
        )
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

    async def notify_condition_alert(
        self,
        *,
        equipment_name: str,
        plant_id,
        machine: Optional[Machine],
        severity: str,
        metric_label: str,
        value: float,
        unit: str,
        limit_value: float,
        ticket_number: Optional[str] = None,
    ) -> None:
        """Sushi Sensor condition-monitoring threshold crossing → SMS/email to
        the plant's level-0 notification group (the same group ticket events
        use). Called fire-and-forget from the sushi ingest path; the caller owns
        severity filtering, freshness and the per-sensor cooldown. Channel
        toggles: esc.sms_enabled/email_enabled + channel_matrix['condition_alert']."""
        esc = await get_escalation_settings(self.db, plant_id)
        recipients = await self._level_recipients(0, machine=machine, priority=severity, plant_id=plant_id)
        if not recipients:
            logger.info("[CONDITION] No level-0 recipients configured — notification skipped")
            return
        sev_label = "CRITIQUE" if severity == "critical" else "ALERTE"
        subject = f"[MES] Condition {sev_label}: {equipment_name}"
        body = (
            f"Condition {sev_label}\n"
            f"Équipement: {equipment_name}\n"
            f"{metric_label}: {value:.2f} {unit} (seuil {limit_value:g} {unit})\n"
            f"Ticket: {ticket_number or '—'}"
        )
        sms_text = render_sms_template(
            esc, "condition_alert",
            severity=sev_label, machine=equipment_name, metric=metric_label,
            value=f"{value:.2f}", unit=unit, limit=f"{limit_value:g}",
            ticket=f" → {ticket_number}" if ticket_number else "",
        )
        await self._dispatch(
            recipients, esc, subject, body, sms_text,
            role_label="condition_alert", trigger="condition_alert",
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
        esc = await get_escalation_settings(self.db, getattr(ticket, "plant_id", None))
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
        pool_q = (
            select(User, Technician.shift)
            .join(Technician, Technician.user_id == User.id)
            .where(Technician.active == True, User.active == True)  # noqa: E712
        )
        # Only technicians with access to the ticket's plant get the ping.
        if getattr(ticket, "plant_id", None) is not None:
            pool_q = pool_q.join(UserPlant, UserPlant.user_id == User.id).where(
                UserPlant.plant_id == ticket.plant_id
            )
        rows = (await self.db.execute(pool_q)).all()

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
        teams_url = teams_channel_on(esc, "claimable_tech")
        if teams_url:
            await self.send_teams(
                teams_url,
                title=subject.removeprefix("[MES] "),
                lines=body.splitlines(),
                link_url=teams_link(ticket_id=ticket.id),
                ticket_id=ticket.id, recipient_role="claimable_tech",
            )

    async def notify_ticket_opened(self, ticket, machine_name: Optional[str]) -> None:
        """Every new ticket → SMS/email to the level-0 contact group, plus the
        technician pool when self-assignment is on (independent of the toggle below)."""
        await self.notify_claimable_to_technicians(ticket, machine_name)
        esc = await get_escalation_settings(self.db, getattr(ticket, "plant_id", None))
        if not esc.notify_on_ticket_opened:
            return
        if not self._meets_group_min_priority(esc, ticket.priority):
            return
        if await self._already_sent(ticket.id, "ticket_opened"):
            return
        machine = await self.db.get(Machine, ticket.machine_id) if ticket.machine_id else None
        recipients = await self._level_recipients(0, machine=machine, priority=ticket.priority,
                                                  plant_id=getattr(ticket, "plant_id", None))
        if not recipients:
            return
        where = machine_name or "Machine"
        subject = f"[MES] Nouveau ticket {ticket.ticket_number} — {where}"
        body = (
            f"Ticket: {ticket.ticket_number}\n"
            f"Machine: {where}\n"
            f"Priorité: {_priority_str(ticket.priority)}\n"
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
        esc = await get_escalation_settings(self.db, getattr(ticket, "plant_id", None))
        if not esc.notify_on_ticket_completed:
            return
        if not self._meets_group_min_priority(esc, ticket.priority):
            return
        if await self._already_sent(ticket.id, "ticket_closed"):
            return
        machine = await self.db.get(Machine, ticket.machine_id) if ticket.machine_id else None
        recipients = await self._level_recipients(0, machine=machine, priority=ticket.priority,
                                                  plant_id=getattr(ticket, "plant_id", None))
        if not recipients:
            return
        # Who finished the work = the assigned technician (kiosk tickets may
        # close unassigned → "—").
        tech = await self.db.get(User, ticket.assigned_to_id) if ticket.assigned_to_id else None
        where = machine_name or "Machine"
        subject = f"[MES] Ticket {ticket.ticket_number} terminé — {where}"
        body = (
            f"Ticket: {ticket.ticket_number}\n"
            f"Machine: {where}\n"
            f"Technicien: {tech.name if tech else '—'}\n"
            f"Diagnostic: {ticket.diagnosis or '—'}\n"
            f"Action: {ticket.corrective_action or '—'}"
        )
        sms_text = render_sms_template(
            esc, "ticket_completed",
            number=ticket.ticket_number, machine=where,
            priority=_priority_str(ticket.priority),
            description=(ticket.description or "")[:90],
            technician=tech.name if tech else "",
        )
        await self._dispatch(
            recipients, esc, subject, body, sms_text,
            role_label="ticket_closed", ticket_id=ticket.id, trigger="ticket_completed",
        )

    async def notify_of_watch_inactive(
        self, *, job_order, watch, minutes: int, location: dict, creator: Optional[User],
    ) -> None:
        """A watched OF (map "spot") stalled past its threshold. Goes to the OF
        alerts group (contacts with category='of') plus the person who placed
        the spot; the Teams card posts to the dedicated OF channel (falling back
        to the machine channel). Called once per stall episode by
        check_inactivity."""
        esc = await get_escalation_settings(self.db, watch.plant_id)
        kind = location.get("kind")
        if kind == "pit_stop":
            where = "Pit Stop" + (f" {location['position_code']}" if location.get("position_code") else "")
        elif kind == "machine" and location.get("parked"):
            where = f"sortie de {location.get('machine_name') or '—'}"
        elif kind == "machine":
            where = location.get("machine_name") or "—"
        else:
            where = "position inconnue"
        subject = f"[MES] OF {job_order.job_number} immobile — {where}"
        body = (
            f"OF suivie: {job_order.job_number}\n"
            f"Produit: {job_order.product_name or '—'}\n"
            f"Position: {where}\n"
            f"Sans mouvement depuis: {minutes} min (seuil {watch.threshold_minutes} min)"
        )
        sms_text = render_sms_template(
            esc, "of_watch",
            number=job_order.job_number, minutes=str(minutes), location=where,
        )
        # Group contacts' scope/quiet-hours apply against the OF's current
        # machine (when it is sitting at one); the creator always qualifies.
        machine = None
        if kind == "machine" and location.get("machine_id"):
            machine = await self.db.get(Machine, UUID(str(location["machine_id"])))
        recipients = await self._of_recipients(watch.plant_id, machine=machine)
        if creator is not None and creator.active and creator.id not in {
            r["user"].id for r in recipients
        }:
            recipients.append({"user": creator, "via_sms": True, "via_email": True})
        sms_on = esc.sms_enabled and channel_enabled(esc, "of_watch", "sms")
        email_on = esc.email_enabled and channel_enabled(esc, "of_watch", "email")
        for r in recipients:
            user = r["user"]
            if sms_on and r["via_sms"] and user.phone:
                await self.send_sms(
                    recipient=user.phone, message=sms_text,
                    recipient_role="of_watch", recipient_name=user.name,
                )
            if email_on and r["via_email"] and user.email:
                await self.send_email(
                    recipient=user.email, subject=subject, body=body,
                    recipient_role="of_watch", recipient_name=user.name,
                )
        teams_url = teams_channel_on(esc, "of_watch", of=True)
        if teams_url:
            await self.send_teams(
                teams_url,
                title=subject.removeprefix("[MES] "),
                lines=body.splitlines(),
                link_url=teams_link(),
                accent=TEAMS_ACCENTS["of_watch"],
                recipient_role="of_watch",
            )

    async def notify_ticket_assigned(self, ticket, user: User, machine_name: str) -> None:
        """Notify the technician when a ticket is assigned to them."""
        esc = await get_escalation_settings(self.db, getattr(ticket, "plant_id", None))
        if not esc.notify_on_ticket_assigned:
            return
        subject = f"[MES] Ticket {ticket.ticket_number} assigné"
        body = (
            f"Ticket: {ticket.ticket_number}\n"
            f"Machine: {machine_name}\n"
            f"Priorité: {_priority_str(ticket.priority)}\n"
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
        teams_url = teams_channel_on(esc, "ticket_assigned")
        if teams_url:
            await self.send_teams(
                teams_url,
                title=f"Ticket {ticket.ticket_number} assigné — {user.name}",
                lines=[f"Machine: {machine_name}", f"Priorité: {_priority_str(ticket.priority)}",
                       ticket.description or ""],
                link_url=teams_link(ticket_id=ticket.id),
                ticket_id=ticket.id, recipient_role="technician",
            )
