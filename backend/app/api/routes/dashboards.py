"""Custom dashboards — user-built grids of widget tiles, each bound to a machine
and a widget type (status | stops | production). Opened by slug for TV displays."""
import re
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_db
from app.models.models import Dashboard, User
from app.core.security import get_current_user

router = APIRouter()


class TileIn(BaseModel):
    i: str
    machine_id: Optional[UUID] = None
    widget: str                       # status | stops | production
    x: int = 0
    y: int = 0
    w: int = 3
    h: int = 4


class DashboardCreate(BaseModel):
    name: str
    tiles: List[TileIn] = []
    is_shared: bool = True


class DashboardUpdate(BaseModel):
    name: Optional[str] = None
    tiles: Optional[List[TileIn]] = None
    is_shared: Optional[bool] = None


class DashboardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    slug: str
    name: str
    is_shared: bool = True
    tiles: list = []


def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "dashboard"


async def _unique_slug(db: AsyncSession, base: str) -> str:
    slug, n = base, 1
    while (await db.execute(select(Dashboard).where(Dashboard.slug == slug))).scalar_one_or_none():
        n += 1
        slug = f"{base}-{n}"
    return slug


async def _get(ref: str, db: AsyncSession) -> Dashboard:
    d = None
    try:
        d = await db.get(Dashboard, UUID(ref))
    except (ValueError, AttributeError):
        d = None
    if d is None:
        d = (await db.execute(select(Dashboard).where(Dashboard.slug == ref))).scalar_one_or_none()
    if d is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return d


@router.get("/", response_model=List[DashboardOut])
async def list_dashboards(db: AsyncSession = Depends(get_db), user: User = Depends(get_current_user)):
    rows = (await db.execute(
        select(Dashboard)
        .where(or_(Dashboard.is_shared == True, Dashboard.created_by_id == user.id))  # noqa: E712
        .order_by(Dashboard.name)
    )).scalars().all()
    return rows


@router.post("/", response_model=DashboardOut)
async def create_dashboard(data: DashboardCreate, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    d = Dashboard(
        slug=await _unique_slug(db, _slugify(data.name)),
        name=data.name, is_shared=data.is_shared, created_by_id=user.id,
        tiles=[t.model_dump(mode="json") for t in data.tiles],
    )
    db.add(d)
    await db.commit()
    await db.refresh(d)
    return d


@router.get("/{ref}", response_model=DashboardOut)
async def get_dashboard(ref: str, db: AsyncSession = Depends(get_db),
                        user: User = Depends(get_current_user)):
    return await _get(ref, db)


@router.patch("/{ref}", response_model=DashboardOut)
async def update_dashboard(ref: str, data: DashboardUpdate, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    d = await _get(ref, db)
    if data.name is not None:
        d.name = data.name
    if data.is_shared is not None:
        d.is_shared = data.is_shared
    if data.tiles is not None:
        d.tiles = [t.model_dump(mode="json") for t in data.tiles]
    await db.commit()
    await db.refresh(d)
    return d


@router.delete("/{ref}", status_code=204)
async def delete_dashboard(ref: str, db: AsyncSession = Depends(get_db),
                           user: User = Depends(get_current_user)):
    d = await _get(ref, db)
    await db.delete(d)
    await db.commit()
