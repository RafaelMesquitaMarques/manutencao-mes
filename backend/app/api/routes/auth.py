from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.db.session import get_db
from app.models.models import Usuario
from app.schemas.usuario import LoginRequest, TokenResponse, UsuarioCreate, UsuarioOut
from app.core.security import verify_password, hash_password, create_access_token, get_current_user

router = APIRouter()


@router.post("/login", response_model=TokenResponse)
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Usuario).where(Usuario.email == data.email, Usuario.ativo == True)
    )
    user = result.scalar_one_or_none()

    if not user or not verify_password(data.password, user.senha_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    token = create_access_token({"sub": str(user.id)})
    return TokenResponse(
        access_token=token,
        user_id=str(user.id),
        nome=user.nome,
        idioma=user.idioma,
    )


@router.post("/register", response_model=UsuarioOut, status_code=201)
async def register(data: UsuarioCreate, db: AsyncSession = Depends(get_db)):
    # Verifica se email já existe
    result = await db.execute(select(Usuario).where(Usuario.email == data.email))
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = Usuario(
        nome=data.nome,
        email=data.email,
        senha_hash=hash_password(data.password),
        idioma=data.idioma,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.get("/me", response_model=UsuarioOut)
async def me(current_user: Usuario = Depends(get_current_user)):
    return current_user
