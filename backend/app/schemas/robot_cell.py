"""Schemas for FANUC CRX robot cells.

CellTelemetry is the read-only ingestion CONTRACT: the JSON a cell / gateway /
MachineMotion pushes to the MES. Every field is optional so a sender can report
only what it has (partial updates merge into the live state). The MES never sends
commands back — there is no motion/safety/reset field here on purpose.
"""
from typing import Optional, List
from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, ConfigDict


# ── Ingestion contract ────────────────────────────────────────────────────────
class CellTelemetry(BaseModel):
    # connectivity / mode
    online: Optional[bool] = None
    run_state: Optional[str] = None          # running | stopped | fault | idle
    op_mode: Optional[str] = None            # auto | manual
    servo_on: Optional[bool] = None
    robot_ready: Optional[bool] = None
    # alarms
    alarm_active: Optional[bool] = None
    alarm_code: Optional[str] = None
    alarm_message: Optional[str] = None
    # production
    current_program: Optional[str] = None
    current_recipe: Optional[str] = None
    current_wo: Optional[str] = None
    current_sku: Optional[str] = None
    cycle_running: Optional[bool] = None
    cycle_complete: Optional[bool] = None
    last_cycle_s: Optional[float] = None
    avg_cycle_s: Optional[float] = None
    good_count: Optional[int] = None
    reject_count: Optional[int] = None
    total_count: Optional[int] = None
    # safety (read-only mirror)
    safety_ok: Optional[bool] = None
    estop_active: Optional[bool] = None
    scanner_zone: Optional[str] = None       # clear | occupied
    collaborative_mode: Optional[bool] = None
    reduced_speed: Optional[bool] = None
    stopped_by_safety: Optional[bool] = None
    gate_state: Optional[str] = None         # open | closed | moving | fault
    reset_required: Optional[bool] = None
    # maintenance / reliability
    robot_running_hours: Optional[float] = None
    servo_hours: Optional[float] = None
    cycle_count: Optional[int] = None
    fault_count: Optional[int] = None
    availability: Optional[float] = None
    mtbf: Optional[float] = None
    mttr: Optional[float] = None


# ── Config (attach a cell to an existing equipment) ─────────────────────────────
class RobotCellUpsert(BaseModel):
    equipment_id: UUID
    cell_model: Optional[str] = None
    controller: Optional[str] = "FANUC R-30iB Mini Plus"
    ip_address: Optional[str] = None
    line: Optional[str] = None
    has_machine_motion: bool = False
    has_gate: bool = False
    has_scanner: bool = False
    has_safety_module: bool = False
    io_modules: List[str] = []
    notes: Optional[str] = None


class RobotCellConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    equipment_id: UUID
    cell_model: Optional[str] = None
    controller: Optional[str] = None
    ip_address: Optional[str] = None
    line: Optional[str] = None
    has_machine_motion: bool = False
    has_gate: bool = False
    has_scanner: bool = False
    has_safety_module: bool = False
    io_modules: Optional[List[str]] = None
    notes: Optional[str] = None


class RobotCellStateOut(CellTelemetry):
    model_config = ConfigDict(from_attributes=True)
    updated_at: Optional[datetime] = None


class RobotCellOut(BaseModel):
    equipment_id: UUID
    equipment_name: Optional[str] = None
    config: RobotCellConfigOut
    state: Optional[RobotCellStateOut] = None
    active_alarms: int = 0
