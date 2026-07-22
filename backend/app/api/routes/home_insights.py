from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.plant_context import PlantContext, get_plant_context
from app.core.security import get_current_user
from app.db.session import get_db
from app.models.models import User
from app.services.home_insights import build_home_insights

router = APIRouter()


@router.get("/home")
async def get_home_insights(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
    ctx: PlantContext = Depends(get_plant_context),
):
    """Live anomaly feed for the Home page. Read-only; detectors are filtered by
    the caller's view permissions, so each role only sees what it may read."""
    return await build_home_insights(db, current_user, ctx)
