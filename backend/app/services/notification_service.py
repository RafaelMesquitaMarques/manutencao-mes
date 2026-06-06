"""
Mock notification service — logs to console and notification_logs table.
Replace each send_* method body with a real SDK (nodemailer, twilio, teams webhook)
when ready for production.
"""
import logging
from typing import Optional
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import NotificationLog

logger = logging.getLogger(__name__)

ESCALATION_CONTACTS = {
    1: {"role": "supervisor",            "name": "Shift Supervisor",     "contact": "supervisor@foliot.com"},
    2: {"role": "maintenance_director",  "name": "Maintenance Director", "contact": "maintenance@foliot.com"},
    3: {"role": "plant_manager",         "name": "Plant Manager",        "contact": "plantmanager@foliot.com"},
}


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
        print(f"[EMAIL MOCK] To: {recipient} | {subject}")
        self.db.add(NotificationLog(
            alert_id=alert_id,
            ticket_id=ticket_id,
            notification_type="email",
            recipient_role=recipient_role,
            recipient_name=recipient_name,
            recipient_contact=recipient,
            message=f"{subject}\n{body}",
            status="sent",
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
    ) -> None:
        # Replace with Twilio SDK call here
        logger.info("[SMS MOCK] To: %s | %s", recipient, message[:80])
        print(f"[SMS MOCK] To: {recipient} | {message[:80]}")
        self.db.add(NotificationLog(
            alert_id=alert_id,
            ticket_id=ticket_id,
            notification_type="sms",
            recipient_role=recipient_role,
            recipient_name=recipient_name,
            recipient_contact=recipient,
            message=message,
            status="sent",
        ))
        await self.db.flush()

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
        print(f"[TEAMS MOCK] To: {recipient} | {message[:80]}")
        self.db.add(NotificationLog(
            alert_id=alert_id,
            ticket_id=ticket_id,
            notification_type="teams",
            recipient_role=recipient_role,
            recipient_name=recipient_name,
            recipient_contact=recipient,
            message=message,
            status="sent",
        ))
        await self.db.flush()

    async def send_escalation(self, level: int, alert) -> None:
        contact = ESCALATION_CONTACTS.get(level)
        if not contact:
            return
        subject = f"[MES] Escalation L{level}: {alert.alert_number}"
        body = (
            f"Escalation Level {level}\n"
            f"Alert: {alert.alert_number}\n"
            f"Priority: {alert.priority}\n"
            f"Problem: {alert.description or 'N/A'}\n"
            f"Open since: {alert.created_at.isoformat()}"
        )
        await self.send_email(
            recipient=contact["contact"],
            subject=subject,
            body=body,
            alert_id=alert.id,
            recipient_role=contact["role"],
            recipient_name=contact["name"],
        )
        await self.send_teams(
            recipient=contact["contact"],
            message=f"{subject}\n{body}",
            alert_id=alert.id,
            recipient_role=contact["role"],
            recipient_name=contact["name"],
        )
