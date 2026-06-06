from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.core.config import settings
from app.db.session import engine
from app.db.base import Base
from app.api.routes import (
    auth, plants, equipment, work_orders,
    maintenance_plans, inventory, alerts, iot, users, kpis, technicians
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield
    await engine.dispose()


app = FastAPI(
    title="MES Maintenance Platform",
    description="Multi-plant maintenance management and industrial monitoring platform",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,              prefix="/api/auth",        tags=["Authentication"])
app.include_router(plants.router,            prefix="/api/plants",      tags=["Plants"])
app.include_router(equipment.router,         prefix="/api/equipment",   tags=["Equipment"])
app.include_router(work_orders.router,       prefix="/api/wo",          tags=["Work Orders"])
app.include_router(maintenance_plans.router, prefix="/api/plans",       tags=["Maintenance Plans"])
app.include_router(inventory.router,         prefix="/api/inventory",   tags=["Inventory"])
app.include_router(alerts.router,            prefix="/api/alerts",      tags=["Alerts"])
app.include_router(iot.router,               prefix="/api/iot",         tags=["IoT / Sensors"])
app.include_router(users.router,             prefix="/api/users",       tags=["Users"])
app.include_router(kpis.router,              prefix="/api/kpis",        tags=["KPIs"])
app.include_router(technicians.router,       prefix="/api/technicians", tags=["Technicians"])


@app.get("/api/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0"}
