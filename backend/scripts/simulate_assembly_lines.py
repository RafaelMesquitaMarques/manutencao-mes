"""Live simulator for the St-Jérôme assembly lines — makes the furniture lines
BUILD OFs in real time so the 3D map, the end-of-line TVs and the OF page come
alive without the real ADAM belts / Cortex stations connected yet.

Two phases:

  1. Catch-up (optional, DB-direct): back-fills the shift so far — a handful of
     already-COMPLETED OFs per line plus their shift/hourly production — so "Réel"
     on the TVs starts near the evolving Standard instead of at 0. Written straight
     to the DB (not HTTP) on purpose: it must NOT feed the live rate/trend pulse,
     or the gauges would spike on a burst of historical units.

  2. Live: drives each line through the SAME HTTP endpoints the real transports use
     (so all status / OEE / OF logic stays server-side, untouched):
       • belt status    → POST /api/machines/{ref}/production-signal  (ADAM source=state)
       • finished units → POST /api/machines/{ref}/of-unit-scan       (Cortex poller)
     Each line runs its current OF at ~its hourly cadence (target_count_per_hour),
     marks it COMPLETED and opens the next when it's filled, and occasionally stops
     (belt turns red) and restarts on its own. The live rate/trend gauges come from
     an in-process pulse inside the API worker, which only real scans hitting the
     API feed — hence HTTP here.

`ts` is sent in the PLANT's local wall-clock (with offset) so each scan lands in
the same shift/date bucket the line-stats read back (container runs UTC; the line
TVs bucket in plant time — a mismatch would read Réel = 0).

Everything is TAGGED for clean removal — OFs: job_number starts with "SIM-ASM-".

Run inside the backend container:
    docker exec -d mes_backend python -m scripts.simulate_assembly_lines --plant QS
    docker exec    mes_backend python -m scripts.simulate_assembly_lines --plant QS --clean

Useful flags:
    --speed 20        cadence multiplier — 1.0 = real ~43/h (slow); 20 = lively demo
    --interval 4      seconds between ticks (default 4)
    --frames 0        0 = loop forever (default); N = stop after N ticks
    --no-stops        never simulate belt stoppages (all lines stay green)
    --no-catchup      start Réel at 0 instead of back-filling the shift so far
"""
import argparse
import asyncio
import json
import random
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import select, delete, update

from app.db.session import AsyncSessionLocal
from app.models.models import (
    Plant, Machine, Equipment, JobOrder, JobOrderRun, MachineStop,
    JobOrderStatus, JobOrderSource, MachineStatus, AlertShift,
)
from app.services.mes_service import MesService

SIM_OF = "SIM-ASM-"
DEFAULT_TZ = "America/Toronto"          # QS / St-Jérôme
DEFAULT_SHIFT_START_H = 7               # Cortex day window opens 07:00

# Product catalogues per line kind (FR — Quebec plant) + realistic batch sizes.
FURNITURE = [
    "Table de conférence chêne 2400", "Bureau exécutif noyer", "Commode 6 tiroirs",
    "Armoire de rangement 2 portes", "Bibliothèque modulaire", "Buffet 3 portes",
    "Meuble TV chêne blanchi", "Table d'appoint érable", "Console d'entrée",
]
REMBOURRAGE = [
    "Fauteuil club cuir", "Canapé 3 places lin", "Chaise capitonnée velours",
    "Pouf rembourré", "Banquette d'entrée tissu",
]
COUSSINS = [
    "Tête de lit capitonnée queen", "Tête de lit king lin",
    "Coussin décoratif velours", "Coussin lombaire ergonomique",
]

# Belt-stop behaviour (per running tick).
STOP_PROB = 0.015                       # chance a running line stops on a given tick
STOP_TICKS = (3, 12)                    # how many ticks a stop lasts


def _catalogue(code: str):
    if "REMB" in code:
        return REMBOURRAGE, (8, 22)
    if "COUS" in code:
        return COUSSINS, (14, 45)
    return FURNITURE, (12, 40)


def _hhmm_to_min(v) -> Optional[int]:
    """'HH:MM' → minutes past midnight, or None."""
    try:
        h, m = [int(x) for x in str(v).split(":")[:2]]
        return h * 60 + m
    except (ValueError, TypeError, AttributeError):
        return None


def _split(total: int, n: int) -> list[int]:
    """Split `total` into `n` positive parts (sizes of the catch-up OFs)."""
    n = max(1, min(n, total))
    base = total // n
    parts = [base] * n
    for i in range(total - base * n):
        parts[i] += 1
    random.shuffle(parts)
    return parts


def _shift_and_date(machine, wall_naive: datetime):
    """(shift, date) a plant-local wall-clock instant belongs to — mirrors
    machines._shift_and_date_for so catch-up production lands in the SAME bucket
    the line TVs read back."""
    cur = wall_naive.hour * 60 + wall_naive.minute

    def bucket(sh: int) -> AlertShift:
        if 4 <= sh < 12:
            return AlertShift.morning
        if 12 <= sh < 20:
            return AlertShift.afternoon
        return AlertShift.night

    for cfg in (machine.shifts_config or {}).values():
        if not isinstance(cfg, dict):
            continue
        try:
            sh, sm = [int(x) for x in str(cfg.get("start", "")).split(":")[:2]]
            eh, em = [int(x) for x in str(cfg.get("end", "")).split(":")[:2]]
        except (ValueError, TypeError):
            continue
        s, e = sh * 60 + sm, eh * 60 + em
        if e > s:
            if s <= cur < e:
                return bucket(sh), wall_naive.date()
        else:
            if cur >= s:
                return bucket(sh), wall_naive.date()
            if cur < e:
                return bucket(sh), wall_naive.date() - timedelta(days=1)
    return AlertShift.morning, wall_naive.date()


class LineSim:
    """Per-line simulation state."""

    def __init__(self, machine: Machine, tz: ZoneInfo):
        self.ref = machine.page_slug or str(machine.id)
        self.token = machine.signal_ingest_token
        self.machine_id = machine.id
        self.plant_id = machine.plant_id
        self.dept = machine.department
        self.name = machine.name
        self.code = (machine.code or "").replace("ASM-", "") or self.ref
        self.cadence = float(machine.target_count_per_hour or 40)
        self.tz = tz
        self.shift_start_h = self._shift_start(machine)
        # The line's ENABLED shift windows (shifts_config is derived = active only) as
        # (start_min, end_min), overnight-aware — the sim only runs the belt inside them.
        self.windows = []
        for cfg in (machine.shifts_config or {}).values():
            if isinstance(cfg, dict):
                s, e = _hhmm_to_min(cfg.get("start")), _hhmm_to_min(cfg.get("end"))
                if s is not None and e is not None:
                    self.windows.append((s, e))
        self.products, self.qty_range = _catalogue(machine.code or "")
        self.running = True
        self.stop_ticks_left = 0
        self.accum = 0.0                # fractional finished units carried between ticks
        self.of_seq = 0
        self.of = None                  # live current OF {number, product, target, made}
        self.filled: list[str] = []     # OF numbers filled live, awaiting completed-mark
        self.total_made = 0
        self.total_of = 0

    @staticmethod
    def _shift_start(machine) -> int:
        for cfg in (machine.shifts_config or {}).values():
            if isinstance(cfg, dict) and cfg.get("start"):
                try:
                    return int(str(cfg["start"]).split(":")[0])
                except (ValueError, TypeError):
                    pass
        return DEFAULT_SHIFT_START_H

    def _next_number(self) -> str:
        self.of_seq += 1
        self.total_of += 1
        return f"{SIM_OF}{self.code}-{self.of_seq:03d}"

    def _new_of(self):
        lo, hi = self.qty_range
        self.of = {
            "number": self._next_number(),
            "product": random.choice(self.products),
            "target": random.randint(lo, hi),
            "made": 0,
        }
        return self.of

    def elapsed_hours(self, now_local: datetime) -> float:
        """Worked hours since the shift opened (clamped 0..~8) — for the catch-up."""
        cur = now_local.hour + now_local.minute / 60.0
        return max(0.0, min(8.0, cur - self.shift_start_h))

    def in_shift(self, now_local: datetime) -> bool:
        """True when the local time falls inside one of the line's ENABLED shifts.
        No windows configured → always on (defensive; the API enforces ≥1 shift)."""
        if not self.windows:
            return True
        cur = now_local.hour * 60 + now_local.minute
        for s, e in self.windows:
            if e > s:                       # same-day window
                if s <= cur < e:
                    return True
            else:                           # overnight window (e.g. 23:30→07:00)
                if cur >= s or cur < e:
                    return True
        return False


# ─── HTTP to the KAIZO API (live phase) ────────────────────────────────────────

def _post(base: str, ref: str, path: str, token: str, body: dict):
    """One authenticated POST (sync — call via asyncio.to_thread)."""
    url = f"{base}/api/machines/{ref}/{path}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Signal-Token", token or "")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return True, resp.status, resp.read().decode()[:200]
    except urllib.error.HTTPError as e:
        return False, e.code, e.read().decode()[:200]
    except Exception as e:  # noqa: BLE001 — URLError, timeout…
        return False, 0, str(e)[:200]


async def _signal(base, line: LineSim, running: bool):
    ok, code, body = await asyncio.to_thread(
        _post, base, line.ref, "production-signal", line.token, {"running": running})
    if not ok:
        print(f"  ! {line.name}: signal {running} failed ({code}) {body}")
    return ok


async def _emit(base, line: LineSim, count: int, ts_local: datetime):
    """Scan `count` finished units for the line, rolling over OFs as they fill
    (the filled OF is queued for a completed-mark)."""
    remaining = count
    while remaining > 0:
        if line.of is None:
            line._new_of()
        elif line.of["made"] >= line.of["target"]:
            line.filled.append(line.of["number"])
            line._new_of()
        of = line.of
        room = max(1, of["target"] - of["made"])
        n = min(remaining, room)
        ok, code, body = await asyncio.to_thread(
            _post, base, line.ref, "of-unit-scan", line.token,
            {
                "job_number": of["number"],
                "count": n,
                "product_name": of["product"],
                "target_quantity": of["target"],
                "ts": ts_local.isoformat(),
            },
        )
        if not ok:
            print(f"  ! {line.name}: scan failed ({code}) {body}")
            return
        of["made"] += n
        line.total_made += n
        remaining -= n


async def _go_idle(line):
    """Take a line OUT of operation for an off-shift period: status → idle (not the
    pink 'unjustified' a production-signal stop would raise — this is planned, not a
    fault), closing any of our own open auto-stops. Done straight in the DB (there's
    no 'idle' ingest endpoint), same as the catch-up."""
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(MachineStop)
            .where(MachineStop.machine_id == line.machine_id,
                   MachineStop.ended_at.is_(None),
                   MachineStop.source == "mes",
                   MachineStop.ticket_id.is_(None))
            .values(ended_at=datetime.now(timezone.utc)))
        m = await s.get(Machine, line.machine_id)
        if m is not None:
            m.current_status = MachineStatus.idle
        await s.commit()


async def _flush_completed(lines):
    """Mark every filled-and-rotated OF as completed (one small batched update)."""
    nums = []
    for l in lines:
        if l.filled:
            nums.extend(l.filled)
            l.filled = []
    if not nums:
        return
    async with AsyncSessionLocal() as s:
        await s.execute(
            update(JobOrder)
            .where(JobOrder.job_number.in_(nums))
            .values(status=JobOrderStatus.completed,
                    completed_at=datetime.now(timezone.utc))
        )
        await s.commit()


# ─── Catch-up (DB-direct history) ──────────────────────────────────────────────

async def _catch_up(lines_by_id: dict, now_local: datetime):
    async with AsyncSessionLocal() as s:
        svc = MesService(s)
        machines = (await s.execute(
            select(Machine).where(Machine.id.in_(list(lines_by_id))))).scalars().all()
        for m in machines:
            line = lines_by_id[m.id]
            hours = line.elapsed_hours(now_local)
            if hours < 0.25:
                continue
            total = int(round(line.cadence * hours * random.uniform(0.82, 0.98)))
            if total <= 0:
                continue
            n_ofs = max(1, min(random.randint(3, 6), total))
            for k, size in enumerate(_split(total, n_ofs)):
                back_h = hours * (n_ofs - k) / (n_ofs + 1)      # spread across the shift
                ended = now_local - timedelta(hours=back_h)
                dur = max(10, int(size / max(line.cadence, 1) * 60))
                started = ended - timedelta(minutes=dur)
                number = line._next_number()
                jo = JobOrder(
                    job_number=number, product_name=random.choice(line.products),
                    target_quantity=size, plant_id=line.plant_id, department=line.dept,
                    machine_id=line.machine_id, source=JobOrderSource.cortex,
                    status=JobOrderStatus.completed,
                    started_at=started.astimezone(timezone.utc),
                    completed_at=ended.astimezone(timezone.utc),
                )
                s.add(jo)
                await s.flush()
                s.add(JobOrderRun(
                    job_order_id=jo.id, machine_id=line.machine_id, plant_id=line.plant_id,
                    department=line.dept, source=JobOrderSource.cortex,
                    started_at=started.astimezone(timezone.utc),
                    ended_at=ended.astimezone(timezone.utc),
                    duration_minutes=dur, pieces=size, rejects=0,
                ))
                shift_enum, log_date = _shift_and_date(m, ended.replace(tzinfo=None))
                await svc.add_production(
                    m.id, size, 0, shift_enum,
                    default_target=m.target_count_per_shift or 480,
                    log_date=log_date, job_number=number)
                hour_utc = ended.astimezone(timezone.utc).replace(
                    minute=0, second=0, microsecond=0)
                await svc.add_hourly_count(m.id, hour_utc, size, 0, job_number=number)
                line.total_made += size
            print(f"  · {line.name}: caught up {total} UE over {hours:.1f}h "
                  f"({n_ofs} completed OF)")
        await s.commit()


# ─── Bootstrap / run / clean ───────────────────────────────────────────────────

async def _bootstrap(plant_code: str):
    async with AsyncSessionLocal() as s:
        plant = (await s.execute(
            select(Plant).where(Plant.code == plant_code))).scalar_one_or_none()
        if plant is None:
            raise SystemExit(f"plant {plant_code!r} not found")
        rows = (await s.execute(
            select(Machine)
            .join(Equipment, Machine.equipment_id == Equipment.id)
            .where(
                Equipment.block_kind == "assembly_line",
                Machine.plant_id == plant.id,
                Equipment.active.isnot(False),
            )
            .order_by(Machine.code)
        )).scalars().all()
        tz_name = getattr(plant, "timezone", None) or DEFAULT_TZ
        try:
            tz = ZoneInfo(tz_name)
        except Exception:  # noqa: BLE001
            tz = ZoneInfo(DEFAULT_TZ)
        lines = [LineSim(m, tz) for m in rows if m.signal_ingest_token]
        skipped = [m.code for m in rows if not m.signal_ingest_token]
        return plant, lines, skipped, tz


async def run(args):
    base = args.api.rstrip("/")
    plant, lines, skipped, tz = await _bootstrap(args.plant)
    if not lines:
        print(f"No assembly lines with a signal token in plant {args.plant}. "
              "Seed them (scripts.seed_assembly_lines) and provision signal tokens first.")
        return
    print(f"Plant {plant.code}: simulating {len(lines)} assembly line(s) "
          f"@ base {base}, speed x{args.speed}.")
    if skipped:
        print(f"  (skipped — no signal token: {', '.join(skipped)})")

    # Set each belt to its correct state for right now: green inside an enabled shift,
    # idle (out of operation) outside every shift. Then back-fill the shift so far.
    now0 = datetime.now(tz)
    for line in lines:
        line.running = line.in_shift(now0)
        if line.running:
            await _signal(base, line, True)
        else:
            await _go_idle(line)
    if args.catchup:
        await _catch_up({l.machine_id: l for l in lines}, now0)

    print("Live. Ctrl-C to stop." + ("" if args.frames == 0 else f" ({args.frames} ticks)"))
    n = 0
    try:
        while args.frames == 0 or n < args.frames:
            now_local = datetime.now(tz)
            for line in lines:
                # Outside every enabled shift → the line goes idle (planned, not a
                # fault): out of operation, producing nothing until its next shift opens.
                if not line.in_shift(now_local):
                    if line.running or line.stop_ticks_left:
                        line.running = False
                        line.stop_ticks_left = 0
                        line.accum = 0.0
                        await _go_idle(line)
                    continue
                if line.stop_ticks_left > 0:
                    line.stop_ticks_left -= 1
                    if line.stop_ticks_left == 0:
                        line.running = True
                        await _signal(base, line, True)   # closes the simulated stop
                    continue
                if not line.running:                      # shift just opened → resume
                    line.running = True
                    await _signal(base, line, True)
                if args.stops and random.random() < STOP_PROB:
                    line.running = False
                    line.stop_ticks_left = random.randint(*STOP_TICKS)
                    await _signal(base, line, False)
                    continue
                line.accum += (line.cadence / 3600.0) * args.speed * args.interval
                units = int(line.accum)
                if units >= 1:
                    line.accum -= units
                    await _emit(base, line, units, now_local)
            await _flush_completed(lines)
            n += 1
            if args.frames == 0 or n < args.frames:
                await asyncio.sleep(args.interval)
    except KeyboardInterrupt:
        print("\nStopping…")
    finally:
        # Leave each line in its correct state for now: green in-shift, idle off-shift
        # — never stuck red from a simulated fault.
        now_end = datetime.now(tz)
        for line in lines:
            if line.in_shift(now_end):
                await _signal(base, line, True)
            else:
                await _go_idle(line)
        await _flush_completed(lines)
    made = sum(l.total_made for l in lines)
    ofs = sum(l.total_of for l in lines)
    print(f"Done. {made} units across {ofs} OFs on {len(lines)} lines.")
    print("Remove the demo OFs with: --clean")


async def clean(plant_code: str):
    async with AsyncSessionLocal() as s:
        plant = (await s.execute(
            select(Plant).where(Plant.code == plant_code))).scalar_one_or_none()
        scope = [JobOrder.job_number.like(SIM_OF + "%")]
        if plant is not None:
            scope.append(JobOrder.plant_id == plant.id)
        ids = (await s.execute(select(JobOrder.id).where(*scope))).scalars().all()
        await s.execute(delete(JobOrder).where(*scope))   # cascades JobOrderRun

        # Close any auto-detected stops we may have left open on the lines (only
        # our own signal-driven "mes" stops without a ticket — never operator/WO
        # ones) and set them back to running, in case the sim was killed abruptly.
        closed = 0
        if plant is not None:
            line_ids = (await s.execute(
                select(Machine.id)
                .join(Equipment, Machine.equipment_id == Equipment.id)
                .where(Equipment.block_kind == "assembly_line",
                       Machine.plant_id == plant.id)
            )).scalars().all()
            if line_ids:
                res = await s.execute(
                    update(MachineStop)
                    .where(MachineStop.machine_id.in_(line_ids),
                           MachineStop.ended_at.is_(None),
                           MachineStop.source == "mes",
                           MachineStop.ticket_id.is_(None))
                    .values(ended_at=datetime.now(timezone.utc)))
                closed = res.rowcount or 0
                await s.execute(
                    update(Machine)
                    .where(Machine.id.in_(line_ids),
                           Machine.current_status == MachineStatus.unjustified)
                    .values(current_status=MachineStatus.running))
        await s.commit()
        print(f"Removed {len(ids)} SIM assembly OFs (runs cascaded); "
              f"closed {closed} auto stop(s) on the lines. "
              "Line shift-production (OEE) rows are left as the lines' own history.")


def main():
    ap = argparse.ArgumentParser(description="Live assembly-line OF simulator.")
    ap.add_argument("--plant", default="QS", help="plant code (default QS)")
    ap.add_argument("--api", default="http://localhost:8000",
                    help="KAIZO API base (default http://localhost:8000, in-container)")
    ap.add_argument("--interval", type=float, default=4.0, help="seconds per tick")
    ap.add_argument("--speed", type=float, default=8.0,
                    help="cadence multiplier (1.0 = real ~43/h; higher = livelier demo)")
    ap.add_argument("--frames", type=int, default=0, help="0 = loop forever")
    ap.add_argument("--no-stops", dest="stops", action="store_false",
                    help="never simulate belt stoppages")
    ap.add_argument("--no-catchup", dest="catchup", action="store_false",
                    help="start Réel at 0 (skip shift back-fill)")
    ap.add_argument("--clean", action="store_true", help="remove SIM assembly OFs and exit")
    ap.set_defaults(stops=True, catchup=True)
    args = ap.parse_args()

    if args.clean:
        asyncio.run(clean(args.plant))
        return
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
