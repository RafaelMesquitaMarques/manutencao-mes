import secrets
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import get_db
from app.models.models import Plant, User, UserInvitation, UserPlant, UserRole, PasswordResetToken
from app.schemas.user import (
    LoginRequest, TokenResponse, UserCreate, UserOut, UserMeUpdate,
    InviteRequest, InviteOut, AcceptInviteRequest,
    ForgotPasswordRequest, ResetPasswordRequest, ChangePasswordRequest,
    ForceChangePasswordRequest, PlantMembershipOut,
)
from app.core.security import verify_password, hash_password, create_access_token, get_current_user
from app.core.permissions import require_admin, effective_permissions
from app.services.email_service import EmailService

router = APIRouter()


async def _plant_memberships(db: AsyncSession, user: User) -> tuple[list[PlantMembershipOut], str | None]:
    """The plants this user may work in, default first.
    Corporate admin sees every active plant (membership rows only refine which
    one is the default); everyone else sees exactly their user_plants rows."""
    links = (await db.execute(
        select(UserPlant, Plant)
        .join(Plant, UserPlant.plant_id == Plant.id)
        .where(UserPlant.user_id == user.id, Plant.active == True)  # noqa: E712
        .order_by(UserPlant.is_default.desc(), UserPlant.created_at)
    )).all()

    if user.role == UserRole.admin:
        default_ids = {lnk.plant_id for lnk, _ in links if lnk.is_default}
        plants = (await db.execute(
            select(Plant).where(Plant.active == True)  # noqa: E712
            .order_by(Plant.created_at, Plant.code)
        )).scalars().all()
        items = [
            PlantMembershipOut(
                plant_id=str(p.id), code=p.code, name=p.name,
                role=UserRole.admin, is_default=p.id in default_ids,
            )
            for p in plants
        ]
    else:
        items = [
            PlantMembershipOut(
                plant_id=str(lnk.plant_id), code=p.code, name=p.name,
                role=lnk.role, is_default=lnk.is_default,
            )
            for lnk, p in links
        ]

    default_id = next((i.plant_id for i in items if i.is_default), items[0].plant_id if items else None)
    return items, default_id


@router.post("/login", response_model=TokenResponse)
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).where(User.email == data.email, User.active == True)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()

    plants, default_plant_id = await _plant_memberships(db, user)
    token = create_access_token({"sub": str(user.id), "role": user.role.value})
    return TokenResponse(
        access_token=token,
        user_id=str(user.id),
        name=user.name,
        language=user.language or "en",
        role=user.role,
        must_change_password=user.must_change_password,
        plants=plants,
        default_plant_id=default_plant_id,
    )


@router.post("/register", response_model=UserOut, status_code=201)
async def register(
    data: UserCreate,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Admin-only direct user creation (open registration is closed)."""
    result = await db.execute(select(User).where(User.email == data.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        name=data.name,
        email=data.email,
        password_hash=hash_password(data.password),
        language=data.language,
        role=data.role,
        must_change_password=True,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.get("/me/plants")
async def my_plants(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Plant memberships of the logged-in user (default first). Used by the
    frontend to (re)hydrate the plant selector for sessions that predate the
    login response carrying `plants`."""
    plants, default_plant_id = await _plant_memberships(db, current_user)
    return {"plants": plants, "default_plant_id": default_plant_id}


@router.get("/permissions")
async def my_permissions(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Effective permissions of the logged-in user ('resource:action' list, or ['*'] for admin).
    Frontend uses this to gate menus, routes and action buttons."""
    return {"permissions": sorted(await effective_permissions(db, current_user))}


@router.patch("/me", response_model=UserOut)
async def update_me(
    data: UserMeUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    for field, value in data.model_dump(exclude_none=True).items():
        setattr(current_user, field, value)
    await db.commit()
    await db.refresh(current_user)
    return current_user


@router.post("/invite", response_model=InviteOut, status_code=201)
async def invite_user(
    data: InviteRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(hours=72)

    invitation = UserInvitation(
        email=data.email,
        role=data.role,
        plant_id=data.plant_id,
        token=token,
        invited_by_id=current_user.id,
        expires_at=expires_at,
    )
    db.add(invitation)
    await db.commit()
    await db.refresh(invitation)

    await EmailService.send_invitation_email(
        db=db,
        recipient_email=data.email,
        token=token,
        invited_by_name=current_user.name,
    )
    return invitation


@router.get("/invite/{token}")
async def get_invitation(token: str, db: AsyncSession = Depends(get_db)):
    """Public: validate an invitation token and return basic info."""
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(UserInvitation).where(
            UserInvitation.token == token,
            UserInvitation.accepted_at == None,
            UserInvitation.expires_at > now,
        )
    )
    invitation = result.scalar_one_or_none()
    if not invitation:
        raise HTTPException(status_code=404, detail="Invalid or expired invitation")
    return {"email": invitation.email, "role": invitation.role.value}


@router.post("/accept-invite", response_model=UserOut, status_code=201)
async def accept_invite(data: AcceptInviteRequest, db: AsyncSession = Depends(get_db)):
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(UserInvitation).where(
            UserInvitation.token == data.token,
            UserInvitation.accepted_at == None,
            UserInvitation.expires_at > now,
        )
    )
    invitation = result.scalar_one_or_none()
    if not invitation:
        raise HTTPException(status_code=400, detail="Invalid or expired invitation token")

    existing = await db.execute(select(User).where(User.email == invitation.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        name=data.name,
        email=invitation.email,
        password_hash=hash_password(data.password),
        language=data.language,
        role=invitation.role,
        invited_by_id=invitation.invited_by_id,
        invited_at=now,
    )
    db.add(user)
    invitation.accepted_at = now
    await db.flush()
    # Plant access is intentional, never inherited: the membership comes from the
    # invitation's plant. Invites without a plant leave the user plant-less until
    # an admin assigns one in Settings → Users.
    if invitation.plant_id:
        db.add(UserPlant(
            user_id=user.id,
            plant_id=invitation.plant_id,
            role=invitation.role,
            is_default=True,
            granted_by_id=invitation.invited_by_id,
        ))
    await db.commit()
    await db.refresh(user)

    await EmailService.send_welcome_email(db=db, recipient_email=user.email, name=user.name)
    return user


@router.post("/forgot-password", status_code=200)
async def forgot_password(data: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(User).where(User.email == data.email, User.active == True)
    )
    user = result.scalar_one_or_none()
    # Always 200 — prevent email enumeration
    if user:
        token = secrets.token_urlsafe(32)
        expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
        reset_token = PasswordResetToken(
            user_id=user.id,
            token=token,
            expires_at=expires_at,
        )
        db.add(reset_token)
        await db.commit()
        await EmailService.send_password_reset_email(
            db=db,
            recipient_email=user.email,
            token=token,
        )
    return {"message": "If that email exists, a reset link has been sent."}


@router.post("/reset-password", status_code=200)
async def reset_password(data: ResetPasswordRequest, db: AsyncSession = Depends(get_db)):
    now = datetime.now(timezone.utc)
    result = await db.execute(
        select(PasswordResetToken).where(
            PasswordResetToken.token == data.token,
            PasswordResetToken.used_at == None,
            PasswordResetToken.expires_at > now,
        )
    )
    reset_token = result.scalar_one_or_none()
    if not reset_token:
        raise HTTPException(status_code=400, detail="Invalid or expired reset token")

    user_result = await db.execute(select(User).where(User.id == reset_token.user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    user.password_hash = hash_password(data.new_password)
    user.must_change_password = False
    reset_token.used_at = now
    await db.commit()
    return {"message": "Password reset successfully"}


@router.post("/change-password", status_code=200)
async def change_password(
    data: ChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not verify_password(data.old_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect current password")

    current_user.password_hash = hash_password(data.new_password)
    current_user.must_change_password = False
    await db.commit()
    return {"message": "Password changed successfully"}


@router.patch("/change-password", status_code=200)
async def force_change_password(
    data: ForceChangePasswordRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Forced password change — no old password required. Only valid when must_change_password=True."""
    if not current_user.must_change_password:
        raise HTTPException(status_code=403, detail="No forced password change pending")
    if len(data.new_password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters")

    current_user.password_hash = hash_password(data.new_password)
    current_user.must_change_password = False
    await db.commit()
    return {"message": "Password changed successfully"}
