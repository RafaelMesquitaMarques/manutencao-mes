"""Kiosk access guard (multi-plant phase 4).

The shop-floor kiosk endpoints are historically unauthenticated (tablets with
no login). This guard adds a per-machine access token so an isolated plant's
kiosks can never read or drive another plant's machines:

  - KIOSK_ENFORCE_TOKEN=false (default): pass-through — exactly the historic
    open behavior, so existing QC tablets keep working until the switch-over.
  - true: a kiosk request must present ``X-Kiosk-Token`` matching the target
    machine's ``kiosk_token``, OR a valid Bearer token of a user holding a
    membership in the machine's plant (office users browsing a kiosk page).

Wired as a ROUTER-LEVEL dependency keyed on the machine path parameter, so
every current and future kiosk endpoint is covered by one declaration.
"""
import uuid as uuid_mod

from fastapi import Depends, HTTPException, Request
from jose import jwt, JWTError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.session import get_db
from app.models.models import Machine, User, UserPlant, UserRole

ERR_KIOSK_TOKEN = "errors.kioskTokenRequired"


async def _resolve_machine(db: AsyncSession, ref: str):
    """Machine by id, code or page_slug — mirrors the kiosk ref convention."""
    try:
        m = await db.get(Machine, uuid_mod.UUID(ref))
        if m:
            return m
    except (ValueError, AttributeError):
        pass
    return (await db.execute(
        select(Machine).where((Machine.code == ref) | (Machine.page_slug == ref)).limit(1)
    )).scalars().first()


async def _bearer_user_in_plant(request: Request, db: AsyncSession, plant_id) -> bool:
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        return False
    try:
        payload = jwt.decode(auth[7:], settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            return False
    except JWTError:
        return False
    user = await db.get(User, uuid_mod.UUID(user_id))
    if not user or not user.active:
        return False
    if user.role == UserRole.admin:
        return True
    if plant_id is None:
        return True                       # unassigned machine: any valid user
    member = (await db.execute(
        select(UserPlant.id).where(
            UserPlant.user_id == user.id, UserPlant.plant_id == plant_id
        )
    )).first()
    return member is not None


def kiosk_ref_guard(param: str):
    """Router dependency: when enforcement is on, requests addressing a machine
    by `param` need the machine's kiosk token or an authorized user."""
    async def _guard(request: Request, db: AsyncSession = Depends(get_db)) -> None:
        if not settings.KIOSK_ENFORCE_TOKEN:
            return
        ref = request.path_params.get(param)
        if not ref:
            return                        # collection route — nothing to key on
        machine = await _resolve_machine(db, str(ref))
        if machine is None:
            return                        # endpoint's own 404 handles it
        token = request.headers.get("x-kiosk-token")
        if token and machine.kiosk_token and token == machine.kiosk_token:
            return
        if await _bearer_user_in_plant(request, db, machine.plant_id):
            return
        raise HTTPException(status_code=403, detail=ERR_KIOSK_TOKEN)
    return _guard
