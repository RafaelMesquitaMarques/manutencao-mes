from pydantic import BaseModel, EmailStr, ConfigDict
from typing import Optional, List
from uuid import UUID
from datetime import datetime
from app.models.models import UserRole


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    name: str
    language: str
    role: UserRole = UserRole.operator
    must_change_password: bool = False


class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str
    language: str = "en"
    role: UserRole = UserRole.operator
    job_title: Optional[str] = None
    phone: Optional[str] = None
    must_change_password: bool = True


class UserMeUpdate(BaseModel):
    name: Optional[str] = None
    language: Optional[str] = None
    avatar_url: Optional[str] = None
    phone: Optional[str] = None


class UserAdminUpdate(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    language: Optional[str] = None
    active: Optional[bool] = None
    role: Optional[UserRole] = None
    phone: Optional[str] = None
    job_title: Optional[str] = None
    avatar_url: Optional[str] = None
    must_change_password: Optional[bool] = None


class UserUpdate(BaseModel):
    name: Optional[str] = None
    language: Optional[str] = None
    active: Optional[bool] = None


class PermissionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    resource: str
    action: str
    granted: bool
    plant_id: Optional[UUID] = None


class PermissionItem(BaseModel):
    resource: str
    action: str
    granted: bool = True
    plant_id: Optional[UUID] = None


class PermissionSet(BaseModel):
    permissions: List[PermissionItem]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    email: str
    language: str
    active: bool
    role: UserRole = UserRole.operator
    avatar_url: Optional[str] = None
    phone: Optional[str] = None
    job_title: Optional[str] = None
    last_login_at: Optional[datetime] = None
    must_change_password: bool = False
    invited_by_id: Optional[UUID] = None
    invited_at: Optional[datetime] = None
    created_at: datetime


class UserPlantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    plant_id: UUID
    role: UserRole


class InviteRequest(BaseModel):
    email: EmailStr
    role: UserRole = UserRole.technician
    plant_id: Optional[UUID] = None


class InviteOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    email: str
    role: UserRole
    token: str
    expires_at: datetime
    created_at: datetime


class AcceptInviteRequest(BaseModel):
    token: str
    name: str
    password: str
    language: str = "en"


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


class ChangePasswordRequest(BaseModel):
    old_password: str
    new_password: str


class ForceChangePasswordRequest(BaseModel):
    new_password: str


class AdminPasswordResetRequest(BaseModel):
    mode: str  # 'generate' | 'manual'
    password: Optional[str] = None
