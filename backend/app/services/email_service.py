from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text


class EmailService:
    @staticmethod
    async def _log(db: AsyncSession, email_type: str, recipient: str, subject: str, body: str) -> None:
        await db.execute(text("""
            INSERT INTO email_logs (email_type, recipient_email, subject, body)
            VALUES (:email_type, :recipient_email, :subject, :body)
        """), {"email_type": email_type, "recipient_email": recipient, "subject": subject, "body": body})
        await db.commit()
        print(f"[EmailService] {email_type} → {recipient} | {subject}")

    @staticmethod
    async def send_invitation_email(db: AsyncSession, recipient_email: str, token: str, invited_by_name: str) -> None:
        subject = "You've been invited to Foliot MES"
        body = (
            f"You have been invited by {invited_by_name} to join the Foliot MES platform.\n"
            f"Use this token to create your account: {token}\n"
            f"The invitation expires in 72 hours."
        )
        await EmailService._log(db, "invitation", recipient_email, subject, body)

    @staticmethod
    async def send_password_reset_email(db: AsyncSession, recipient_email: str, token: str) -> None:
        subject = "Foliot MES — Password Reset Request"
        body = (
            f"A password reset was requested for your account.\n"
            f"Reset token: {token}\n"
            f"This token is valid for 1 hour."
        )
        await EmailService._log(db, "password_reset", recipient_email, subject, body)

    @staticmethod
    async def send_welcome_email(db: AsyncSession, recipient_email: str, name: str) -> None:
        subject = "Welcome to Foliot MES"
        body = f"Welcome {name}! Your Foliot MES account has been created successfully."
        await EmailService._log(db, "welcome", recipient_email, subject, body)
