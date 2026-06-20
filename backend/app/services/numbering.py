"""Sequential document numbers (WO-2026-00009, TKT-…, ALT-…).

Max-based instead of count-based: deleting a record never makes the counter
regress, so numbers are never reused and unique constraints never collide.
"""
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession


async def next_number(db: AsyncSession, column, prefix: str) -> str:
    """Next number for a series, e.g. next_number(db, WorkOrder.wo_number, "WO-2026")."""
    r = await db.execute(
        select(func.max(column)).where(column.like(f"{prefix}-%"))
    )
    last = r.scalar()
    seq = 1
    if last:
        try:
            seq = int(str(last).rsplit("-", 1)[1]) + 1
        except (ValueError, IndexError):
            seq = 1
    return f"{prefix}-{seq:05d}"
