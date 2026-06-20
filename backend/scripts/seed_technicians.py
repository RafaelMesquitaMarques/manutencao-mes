"""
One-off import of the YRJ maintenance team.
Idempotent: skips users whose email already exists, and technician profiles
that already exist. Run inside the backend container.
"""
import asyncio
import unicodedata

from sqlalchemy import select

from app.db.session import AsyncSessionLocal
from app.core.security import hash_password
from app.models.models import (
    User, Technician, UserRole, TechnicianSpecialty,
)

DEFAULT_PASSWORD = "Foliot2026!"
EMAIL_DOMAIN = "foliot.com"

# (last_name, first_name, matricule, job_title, role, specialty|None)
PEOPLE = [
    ("Andrianarilanto", "Mara Rafalimanan", "YRJ011163", "Électromécanicien - 1", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("Balaguer-Doucet", "Jonathan", "YRJ011071", "Électromécanicien - 2", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("Beauséjour", "Bernard", "YRJ010009", "Préposé à l'entretien du bâtiment", UserRole.technician, TechnicianSpecialty.mechanical),
    ("Bouchard", "Olivier", "YRJ011047", "Électromécanicien - 1", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("Brunet", "Antoine", "YRJ011657", "Électromécanicien - 1", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("El-bachari", "Abdelali", "YRJ011407", "Électromécanicien - 2", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("Kameni Moukam", "Audrey Durant", "YRJ011583", "Électrotechnicien - 3", UserRole.technician, TechnicianSpecialty.electrical),
    ("Leblanc", "Kevin", "YRJ011418", "Mécanicien industriel - 2", UserRole.technician, TechnicianSpecialty.mechanical),
    ("Ludavicius", "Alexei", "YRJ011417", "Planificateur de la maintenance", UserRole.supervisor, None),
    ("Manriquez Gomez", "Javier", "YRJ011639", "Électromécanicien - 1", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("Mimeault Léveillé", "Alexandre", "YRJ010288", "Électrotechnicien - 3", UserRole.technician, TechnicianSpecialty.electrical),
    ("Perron", "Frédérick", "YRJ010065", "Directeur - Maintenance", UserRole.maintenance_director, None),
    ("Pronovost", "Olivier", "YRJ010076", "Électromécanicien - 3", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("Renaud", "Mathieu", "YRJ010854", "Mécanicien industriel - 1", UserRole.technician, TechnicianSpecialty.mechanical),
    ("St-Amand", "Gabriel", "YRJ011192", "Électromécanicien - 2", UserRole.technician, TechnicianSpecialty.electromechanical),
    ("Wangemann", "Ralf", "YRJ011496", "Électromécanicien - 3", UserRole.technician, TechnicianSpecialty.electromechanical),
]


def strip_accents(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c)
    )


def slug(s: str) -> str:
    s = strip_accents(s).lower()
    out = []
    for ch in s:
        if ch.isalnum():
            out.append(ch)
        elif ch in (" ", "-", "'"):
            out.append("-")
    # collapse repeated/edge hyphens
    parts = [p for p in "".join(out).split("-") if p]
    return "-".join(parts)


def make_email(first_name: str, last_name: str) -> str:
    initial = strip_accents(first_name).strip()[0].lower()
    return f"{initial}.{slug(last_name)}@{EMAIL_DOMAIN}"


async def main():
    created_users = 0
    created_techs = 0
    skipped = 0
    rows = []

    async with AsyncSessionLocal() as db:
        for last, first, matricule, title, role, specialty in PEOPLE:
            email = make_email(first, last)
            display = f"{first} {last}"

            existing = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
            if existing:
                user = existing
                skipped += 1
                status = "exists"
            else:
                user = User(
                    name=display,
                    email=email,
                    password_hash=hash_password(DEFAULT_PASSWORD),
                    role=role,
                    job_title=title,
                    language="fr",
                    must_change_password=True,
                    active=True,
                )
                db.add(user)
                await db.flush()
                created_users += 1
                status = "created"

            if specialty is not None:
                tech = (await db.execute(
                    select(Technician).where(Technician.user_id == user.id)
                )).scalar_one_or_none()
                if not tech:
                    db.add(Technician(
                        user_id=user.id,
                        employee_number=matricule,
                        specialty=specialty,
                        certifications=[],
                        active=True,
                    ))
                    created_techs += 1

            rows.append((status, role.value, email, matricule if specialty else "—", display))

        await db.commit()

    print(f"\n{'STATUS':<8} {'ROLE':<22} {'EMAIL':<34} {'MATRICULE':<12} NAME")
    print("-" * 100)
    for status, role, email, matricule, name in rows:
        print(f"{status:<8} {role:<22} {email:<34} {matricule:<12} {name}")
    print("-" * 100)
    print(f"Users created: {created_users} | Technician profiles created: {created_techs} | Users already existing: {skipped}")
    print(f"Default password for new users: {DEFAULT_PASSWORD} (must change on first login)")


if __name__ == "__main__":
    asyncio.run(main())
