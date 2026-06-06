from pydantic import BaseModel, EmailStr, ConfigDict
from typing import Optional
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


class UserCreate(BaseModel):
    name: str
    email: EmailStr
    password: str
    language: str = "en"


class UserUpdate(BaseModel):
    name: Optional[str] = None
    language: Optional[str] = None
    active: Optional[bool] = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    email: str
    language: str
    active: bool
    created_at: datetime


class UserPlantOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    plant_id: UUID
    role: UserRole
