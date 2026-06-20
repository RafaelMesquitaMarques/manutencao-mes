"""Transport-agnostic ingestion for robot-cell telemetry.

Whatever the final transport ends up being (HTTP, MQTT, OPC UA gateway), it calls
`ingest_telemetry(...)`. This keeps the data model + business logic in one place so
the real transport/auth can be wired later without touching any of this.

Strictly READ-ONLY with respect to the cell: we store and mirror state, we never
emit commands. run_state is mirrored into the linked Machine so the factory-map /
3D twin reflects the cell live.
"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    RobotCell, RobotCellState, RobotCellSample, RobotCellAlarm,
    Machine, MachineStatus,
)
from app.schemas.robot_cell import CellTelemetry

# Cell run_state → MES machine status (drives the twin colour/animation).
_RUN_TO_MACHINE = {
    "running": MachineStatus.running,
    "stopped": MachineStatus.stopped,
    "fault": MachineStatus.maintenance,
    "idle": MachineStatus.idle,
}

# Which telemetry fields are simple state columns we copy straight over.
_STATE_FIELDS = [
    "online", "run_state", "op_mode", "servo_on", "robot_ready",
    "alarm_active", "alarm_code", "alarm_message",
    "current_program", "current_recipe", "current_wo", "current_sku",
    "cycle_running", "cycle_complete", "last_cycle_s", "avg_cycle_s",
    "good_count", "reject_count", "total_count",
    "safety_ok", "estop_active", "scanner_zone", "collaborative_mode",
    "reduced_speed", "stopped_by_safety", "gate_state", "reset_required",
    "robot_running_hours", "servo_hours", "cycle_count", "fault_count",
    "availability", "mtbf", "mttr",
]


async def ingest_telemetry(db: AsyncSession, cell: RobotCell, t: CellTelemetry, now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    data = t.model_dump(exclude_unset=True)   # only fields the sender actually reported

    # 1) Upsert the live snapshot
    state = (await db.execute(
        select(RobotCellState).where(RobotCellState.cell_id == cell.id)
    )).scalar_one_or_none()
    if state is None:
        state = RobotCellState(cell_id=cell.id)
        db.add(state)
    for f in _STATE_FIELDS:
        if f in data:
            setattr(state, f, data[f])
    state.updated_at = now

    # 2) Append a history sample (for trends / availability over time)
    db.add(RobotCellSample(
        cell_id=cell.id, equipment_id=cell.equipment_id, timestamp=now,
        run_state=state.run_state, total_count=state.total_count,
        good_count=state.good_count, reject_count=state.reject_count,
        last_cycle_s=state.last_cycle_s, availability=state.availability,
        alarm_active=state.alarm_active,
    ))

    # 3) Alarm log — open on active, close on clear
    if "alarm_active" in data:
        open_alarms = (await db.execute(
            select(RobotCellAlarm).where(
                RobotCellAlarm.cell_id == cell.id, RobotCellAlarm.active == True
            )
        )).scalars().all()
        if data.get("alarm_active"):
            code = data.get("alarm_code") or (open_alarms[0].code if open_alarms else None)
            already = any(a.code == code for a in open_alarms)
            if not already:
                db.add(RobotCellAlarm(
                    cell_id=cell.id, equipment_id=cell.equipment_id,
                    code=code, message=data.get("alarm_message"),
                    severity="critical" if data.get("estop_active") else "warning",
                    raised_at=now, active=True,
                ))
        else:
            for a in open_alarms:
                a.active = False
                a.cleared_at = now

    # 4) Mirror run_state into the linked Machine → factory map / 3D twin
    if "run_state" in data and data["run_state"] in _RUN_TO_MACHINE:
        machine = (await db.execute(
            select(Machine).where(Machine.equipment_id == cell.equipment_id)
        )).scalar_one_or_none()
        if machine is not None:
            machine.current_status = _RUN_TO_MACHINE[data["run_state"]]
            if data["run_state"] == "stopped":
                machine.last_stop_at = now

    await db.commit()
