from pydantic import BaseModel, EmailStr
from typing import Optional
from uuid import UUID
from datetime import datetime
from app.models.models import RolUsuario


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user_id: str
    nome: str
    idioma: str


class UsuarioCreate(BaseModel):
    nome: str
    email: EmailStr
    password: str
    idioma: str = "en"


class UsuarioUpdate(BaseModel):
    nome: Optional[str] = None
    idioma: Optional[str] = None
    ativo: Optional[bool] = None


class UsuarioOut(BaseModel):
    id: UUID
    nome: str
    email: str
    idioma: str
    ativo: bool
    criado_em: datetime

    class Config:
        from_attributes = True


class UsuarioUsinaOut(BaseModel):
    usina_id: UUID
    usina_nome: str
    papel: RolUsuario

    class Config:
        from_attributes = True
