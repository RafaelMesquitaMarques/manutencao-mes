from datetime import datetime, timezone
from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func

from app.models.models import MachineHistory, WorkOrder, MaintenanceTicket, Machine, WOPart


class MachineHistoryService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def record_from_wo(self, wo: WorkOrder) -> MachineHistory | None:
        """Create a machine history entry when a WO is completed. Returns None if no machine_id."""
        if not wo.machine_id:
            return None
        machine = await self.db.get(Machine, wo.machine_id)
        if not machine:
            return None

        # Gather parts used from wo_parts
        r = await self.db.execute(
            select(WOPart).where(WOPart.work_order_id == wo.id)
        )
        parts = r.scalars().all()
        parts_list = [
            {
                "description": p.description,
                "quantity": p.quantity,
                "unit": p.unit,
                "part_number": p.part_number,
            }
            for p in parts
        ]

        ticket = None
        if wo.ticket_id:
            ticket = await self.db.get(MaintenanceTicket, wo.ticket_id)

        wo_type = wo.type.value if hasattr(wo.type, "value") else str(wo.type)
        problem_type = None
        if ticket and ticket.problem_type:
            problem_type = ticket.problem_type.value if hasattr(ticket.problem_type, "value") else str(ticket.problem_type)

        entry = MachineHistory(
            machine_id=wo.machine_id,
            work_order_id=wo.id,
            ticket_id=wo.ticket_id,
            event_type=wo_type,
            problem_type=problem_type,
            description=wo.description or (ticket.description if ticket else None),
            diagnosis=wo.root_cause or (ticket.diagnosis if ticket else None),
            corrective_action=wo.solution_applied or (ticket.corrective_action if ticket else None),
            parts_used=parts_list,
            technician_id=wo.executor_id,
            downtime_minutes=wo.actual_downtime_minutes or wo.downtime_minutes,
            total_minutes=wo.total_minutes or wo.repair_hours and int(wo.repair_hours * 60),
            occurred_at=wo.opened_at or wo.created_at,
            completed_at=wo.completed_at or datetime.now(timezone.utc),
        )
        self.db.add(entry)

        # Update machine.last_maintenance_at
        machine.last_maintenance_at = datetime.now(timezone.utc)

        return entry

    async def get_machine_metrics(self, machine_id: UUID) -> dict:
        """Return MTTR, MTBF, and failure counts for the given machine."""
        r = await self.db.execute(
            select(MachineHistory).where(MachineHistory.machine_id == machine_id)
            .order_by(MachineHistory.occurred_at)
        )
        entries = r.scalars().all()

        total_events = len(entries)
        corrective = [e for e in entries if e.event_type == "corrective"]
        total_downtime = sum(e.downtime_minutes or 0 for e in corrective)
        total_repair   = sum(e.total_minutes or 0 for e in corrective)

        mttr = (total_repair / len(corrective)) if corrective else 0
        # MTBF: mean time between corrective failures
        if len(corrective) > 1:
            times = sorted(e.occurred_at for e in corrective)
            gaps = [(times[i+1] - times[i]).total_seconds() / 60 for i in range(len(times)-1)]
            mtbf = sum(gaps) / len(gaps)
        else:
            mtbf = 0

        return {
            "total_events": total_events,
            "corrective_count": len(corrective),
            "total_downtime_minutes": total_downtime,
            "mttr_minutes": round(mttr, 1),
            "mtbf_minutes": round(mtbf, 1),
        }
