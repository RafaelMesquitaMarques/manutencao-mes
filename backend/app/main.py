from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from app.core.config import settings
from app.db.session import engine
from app.db.base import Base
from app.api.routes import (
    auth, usinas, equipamentos, ordens_servico,
    planos_manutencao, estoque, alertas, iot, usuarios, kpis, tecnicos
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

app.include_router(auth.router,              prefix="/api/auth",       tags=["Authentication"])
app.include_router(usinas.router,            prefix="/api/plants",     tags=["Plants"])
app.include_router(equipamentos.router,      prefix="/api/equipment",  tags=["Equipment"])
app.include_router(ordens_servico.router,    prefix="/api/wo",         tags=["Work Orders"])
app.include_router(planos_manutencao.router, prefix="/api/plans",      tags=["Maintenance Plans"])
app.include_router(estoque.router,           prefix="/api/inventory",  tags=["Inventory"])
app.include_router(alertas.router,           prefix="/api/alerts",     tags=["Alerts"])
app.include_router(iot.router,               prefix="/api/iot",        tags=["IoT / Sensors"])
app.include_router(usuarios.router,          prefix="/api/users",      tags=["Users"])
app.include_router(kpis.router,              prefix="/api/kpis",       tags=["KPIs"])
app.include_router(tecnicos.router,          prefix="/api/technicians", tags=["Technicians"])


@app.get("/api/health", tags=["System"])
async def health():
    return {"status": "ok", "version": "0.1.0"}