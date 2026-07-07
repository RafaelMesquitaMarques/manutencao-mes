"""End-of-shift summary — template-based, zero AI tokens.

The cron (main._shift_report_loop) calls check_and_send() every minute. When a
machine shift window (Machine.shifts_config) has just ended, it aggregates
production, rejects, stops, availability and open tickets for every machine
sharing that window, renders a compact text in each recipient's language
(en/fr/es) and SMSes the level-1 escalation contacts (shift supervisors).
shift_reports rows are both the audit trail and the dedup ledger.

shifts_config HH:MM values are plant-local wall clock (what the kiosk shows),
so windows are built in the plant's timezone and converted to UTC — unlike
mes_service.shift_windows, which treats them as UTC (its callers compensate
on the frontend; a background cron can't).
"""
import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import (
    AlertShift, Machine, MachineProductionLog, MachineStop, MaintenanceTicket,
    Plant, ShiftReport, StopCategory, StopSubcategory, StopCategoryType, TicketStatus,
)
from app.services.notification_service import NotificationService, get_escalation_settings

logger = logging.getLogger(__name__)

DEFAULT_TZ = "America/Toronto"
# How long after a shift ends the cron may still generate its report
# (covers backend restarts around the boundary).
GRACE_MINUTES = 30

_OPEN_TICKET_STATUSES = [
    TicketStatus.open, TicketStatus.in_progress,
    TicketStatus.on_hold_parts, TicketStatus.on_hold_ext,
]

_L10N = {
    "en": {
        "title": "Shift report", "prod": "Prod", "target": "target",
        "rejects": "Rejects", "avail": "Avail", "stops": "Stops",
        "top_cause": "Top cause", "tickets": "Open tickets", "watch": "Watch",
        "no_data": "No production data recorded this shift.",
        "shifts": {"morning": "Morning", "afternoon": "Afternoon", "night": "Night"},
    },
    "fr": {
        "title": "Rapport de quart", "prod": "Prod", "target": "cible",
        "rejects": "Rejets", "avail": "Dispo", "stops": "Arrêts",
        "top_cause": "Cause n°1", "tickets": "Tickets ouverts", "watch": "À surveiller",
        "no_data": "Aucune production enregistrée sur ce quart.",
        "shifts": {"morning": "Matin", "afternoon": "Après-midi", "night": "Nuit"},
    },
    "es": {
        "title": "Informe de turno", "prod": "Prod", "target": "objetivo",
        "rejects": "Rechazos", "avail": "Dispo", "stops": "Paros",
        "top_cause": "Causa nº1", "tickets": "Tickets abiertos", "watch": "Vigilar",
        "no_data": "Sin producción registrada en este turno.",
        "shifts": {"morning": "Mañana", "afternoon": "Tarde", "night": "Noche"},
    },
}


def _tz(name: Optional[str]) -> ZoneInfo:
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def keyed_shift_windows(
    shifts_config: Optional[dict], for_date: date, tz: ZoneInfo,
) -> list[tuple[str, datetime, datetime]]:
    """(shift_key, start_utc, end_utc) per configured shift for a plant-local
    date. Overnight shifts roll past midnight and belong to the date they start.
    No merging and no full-day fallback (machines without a config are skipped)."""
    out: list[tuple[str, datetime, datetime]] = []
    for key, cfg in (shifts_config or {}).items():
        if not isinstance(cfg, dict):
            continue
        try:
            sh, sm = [int(x) for x in str(cfg.get("start", "")).split(":")[:2]]
            eh, em = [int(x) for x in str(cfg.get("end", "")).split(":")[:2]]
        except (ValueError, TypeError):
            continue
        start_local = datetime.combine(for_date, time(sh, sm), tzinfo=tz)
        end_local = datetime.combine(for_date, time(eh, em), tzinfo=tz)
        if end_local <= start_local:
            end_local += timedelta(days=1)
        out.append((key, start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)))
    return out


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def _overlap_seconds(s: datetime, e: datetime, ws: datetime, we: datetime) -> float:
    return max(0.0, (min(e, we) - max(s, ws)).total_seconds())


async def _machine_stats(
    db: AsyncSession, machine: Machine, shift_key: str,
    ws: datetime, we: datetime, now: datetime,
) -> Optional[dict]:
    """Aggregates for one machine over one window; None when the machine has no
    signal at all this shift (no production, no stops, no open tickets)."""
    actual = rejects = target = 0
    try:
        shift_enum = AlertShift(shift_key)
    except ValueError:
        shift_enum = None  # custom shift key — no per-shift production rows to match
    if shift_enum is not None:
        rows = (await db.execute(
            select(MachineProductionLog).where(
                MachineProductionLog.machine_id == machine.id,
                MachineProductionLog.shift == shift_enum,
                # rows are stamped with the server's UTC date, which is the
                # window's start or end date depending on the time of day
                MachineProductionLog.date.in_({ws.date(), we.date()}),
            )
        )).scalars().all()
        actual = sum(r.actual_count or 0 for r in rows)
        rejects = sum(r.reject_count or 0 for r in rows)
        target = max((r.target_count or 0 for r in rows), default=0)

    stop_rows = (await db.execute(
        select(MachineStop, StopCategory, StopSubcategory)
        .outerjoin(StopCategory, MachineStop.stop_category_id == StopCategory.id)
        .outerjoin(StopSubcategory, MachineStop.stop_subcategory_id == StopSubcategory.id)
        .where(
            MachineStop.machine_id == machine.id,
            MachineStop.started_at < we,
            or_(MachineStop.ended_at.is_(None), MachineStop.ended_at > ws),
        )
    )).all()
    stops_n = 0
    downtime_secs = 0.0
    by_cause: dict = {}
    for stop, cat, sub in stop_rows:
        s = _as_utc(stop.started_at)
        e = _as_utc(stop.ended_at) if stop.ended_at else min(now, we)
        secs = _overlap_seconds(s, e, ws, we)
        if secs <= 0:
            continue
        stops_n += 1
        if cat is not None and cat.type == StopCategoryType.planned:
            continue
        downtime_secs += secs
        if cat is not None:
            entry = by_cause.setdefault(str(cat.id), {
                "secs": 0.0,
                "names": {lang: getattr(cat, f"name_{lang}", None) or cat.name for lang in _L10N},
                "subs": {},
            })
            entry["secs"] += secs
            if sub is not None:
                sentry = entry["subs"].setdefault(str(sub.id), {
                    "secs": 0.0,
                    "names": {lang: getattr(sub, f"name_{lang}", None) or sub.name for lang in _L10N},
                })
                sentry["secs"] += secs

    open_tickets = (await db.execute(
        select(func.count(MaintenanceTicket.id)).where(
            MaintenanceTicket.machine_id == machine.id,
            MaintenanceTicket.status.in_(_OPEN_TICKET_STATUSES),
        )
    )).scalar() or 0

    if actual == 0 and stops_n == 0 and open_tickets == 0:
        return None

    planned_secs = (we - ws).total_seconds()
    availability = max(0.0, min(1.0, (planned_secs - downtime_secs) / planned_secs)) if planned_secs > 0 else 1.0
    perf = min(actual / target, 1.0) if target > 0 else None
    quality = (actual - rejects) / actual if actual > 0 else None
    oee = availability * perf * quality if (perf is not None and quality is not None) else None
    top = max(by_cause.values(), key=lambda c: c["secs"]) if by_cause else None
    top_sub = max(top["subs"].values(), key=lambda s: s["secs"]) if (top and top["subs"]) else None
    return {
        "name": machine.display_name or machine.name,
        "actual": actual, "target": target, "rejects": rejects,
        "stops_n": stops_n, "downtime_min": round(downtime_secs / 60),
        "availability": availability, "oee": oee,
        "open_tickets": int(open_tickets),
        "top_cause": top["names"] if top else None,
        "top_cause_sub": top_sub["names"] if top_sub else None,
        "top_cause_min": round(top["secs"] / 60) if top else 0,
    }


async def build_report_data(
    db: AsyncSession, machines: list[Machine], shift_key: str,
    ws: datetime, we: datetime, tz_name: str,
) -> dict:
    per_machine = []
    for m in machines:
        stats = await _machine_stats(db, m, shift_key, ws, we, datetime.now(timezone.utc))
        if stats:
            per_machine.append(stats)

    cause_totals: dict[str, dict] = {}
    for s in per_machine:
        if s["top_cause"]:
            entry = cause_totals.setdefault(s["top_cause"]["en"], {"names": s["top_cause"], "min": 0, "subs": {}})
            entry["min"] += s["top_cause_min"]
            if s.get("top_cause_sub"):
                sub = entry["subs"].setdefault(s["top_cause_sub"]["en"], {"names": s["top_cause_sub"], "min": 0})
                sub["min"] += s["top_cause_min"]
    top_cause = max(cause_totals.values(), key=lambda c: c["min"]) if cause_totals else None
    top_cause_sub = (
        max(top_cause["subs"].values(), key=lambda c: c["min"])
        if (top_cause and top_cause["subs"]) else None
    )
    with_oee = [s for s in per_machine if s["oee"] is not None]
    return {
        "shift_key": shift_key,
        "window_start": ws, "window_end": we, "tz": tz_name,
        "machines": per_machine,
        "top_cause": top_cause["names"] if top_cause else None,
        "top_cause_sub": top_cause_sub["names"] if top_cause_sub else None,
        "totals": {
            "actual": sum(s["actual"] for s in per_machine),
            "target": sum(s["target"] for s in per_machine),
            "rejects": sum(s["rejects"] for s in per_machine),
            "stops_n": sum(s["stops_n"] for s in per_machine),
            "downtime_min": sum(s["downtime_min"] for s in per_machine),
            "availability": (sum(s["availability"] for s in per_machine) / len(per_machine)) if per_machine else None,
            "oee": (sum(s["oee"] for s in with_oee) / len(with_oee)) if with_oee else None,
            "open_tickets": sum(s["open_tickets"] for s in per_machine),
        },
        "worst": sorted(
            (s for s in per_machine if s["downtime_min"] > 0),
            key=lambda s: s["downtime_min"], reverse=True,
        )[:3],
    }


def _cause_label(cause: Optional[dict], sub: Optional[dict], lang: str) -> str:
    """"Group > subgroup" (both localized) for a top cause; ASCII ">" keeps the
    SMS in the GSM-7 charset. Falls back to English, then empty when no cause."""
    if not cause:
        return ""
    name = cause.get(lang) or cause.get("en") or ""
    if sub:
        name += f" > {sub.get(lang) or sub.get('en')}"
    return name


def render_report(data: dict, lang: str) -> str:
    L = _L10N.get(lang if lang in _L10N else "en", _L10N["en"])
    tz = _tz(data.get("tz"))
    ws_l = data["window_start"].astimezone(tz)
    we_l = data["window_end"].astimezone(tz)
    shift_label = L["shifts"].get(data["shift_key"], data["shift_key"])
    header = f"[KAIZO] {L['title']} {shift_label} {ws_l:%H:%M}–{we_l:%H:%M} ({ws_l:%d/%m})"
    t = data["totals"]
    if not data["machines"]:
        return f"{header}\n{L['no_data']}"
    lines = [header]
    prod = f"{L['prod']}: {t['actual']} pcs"
    if t["target"]:
        prod += f" / {L['target']} {t['target']}"
    lines.append(f"{prod} | {L['rejects']}: {t['rejects']}")
    perf_bits = []
    if t["availability"] is not None:
        perf_bits.append(f"{L['avail']}: {round(t['availability'] * 100)}%")
    if t["oee"] is not None:
        perf_bits.append(f"OEE: {round(t['oee'] * 100)}%")
    if perf_bits:
        lines.append(" | ".join(perf_bits))
    stops_line = f"{L['stops']}: {t['stops_n']} ({t['downtime_min']} min)"
    if data.get("top_cause"):
        cause_name = _cause_label(data["top_cause"], data.get("top_cause_sub"), lang)
        stops_line += f" | {L['top_cause']}: {cause_name}"
    lines.append(stops_line)
    lines.append(f"{L['tickets']}: {t['open_tickets']}")
    if data["worst"]:
        watch = ", ".join(
            f"{s['name']} {s['downtime_min']}min"
            + (f" ({_cause_label(s['top_cause'], s.get('top_cause_sub'), lang)})" if s["top_cause"] else "")
            for s in data["worst"]
        )
        lines.append(f"{L['watch']}: {watch}")
    return "\n".join(lines)


async def _plant_tz_names(db: AsyncSession) -> dict:
    rows = (await db.execute(select(Plant.id, Plant.timezone))).all()
    return {pid: tzname for pid, tzname in rows}


async def _candidate_groups(db: AsyncSession, now: datetime) -> dict:
    """Shift windows grouped by (key, start, end): {group: {"machines": [...], "tz": name}}."""
    tz_by_plant = await _plant_tz_names(db)
    machines = (await db.execute(
        select(Machine).where(Machine.is_active == True, Machine.shifts_config.isnot(None))  # noqa: E712
    )).scalars().all()
    groups: dict = {}
    for m in machines:
        tz_name = tz_by_plant.get(m.plant_id) or DEFAULT_TZ
        tz = _tz(tz_name)
        today_local = now.astimezone(tz).date()
        for d in (today_local, today_local - timedelta(days=1)):
            for key, ws, we in keyed_shift_windows(m.shifts_config, d, tz):
                g = groups.setdefault((key, ws, we), {"machines": [], "tz": tz_name})
                if m not in g["machines"]:
                    g["machines"].append(m)
    return groups


async def check_and_send(db: AsyncSession) -> int:
    """Cron entry point: generate + send reports for windows that just ended.
    Returns the number of reports generated."""
    esc = await get_escalation_settings(db)
    if not getattr(esc, "shift_report_enabled", False):
        return 0
    now = datetime.now(timezone.utc)
    generated = 0
    groups = await _candidate_groups(db, now)
    for (key, ws, we), g in sorted(groups.items(), key=lambda kv: kv[0][2]):
        if not (we <= now < we + timedelta(minutes=GRACE_MINUTES)):
            continue
        exists = (await db.execute(
            select(ShiftReport.id).where(
                ShiftReport.shift_key == key, ShiftReport.window_start == ws,
            ).limit(1)
        )).first()
        if exists:
            continue
        data = await build_report_data(db, g["machines"], key, ws, we, g["tz"])
        notif = NotificationService(db)
        recipients = await notif._level_recipients(1)
        sent = 0
        for r in recipients:
            user = r["user"]
            if not (esc.sms_enabled and r["via_sms"] and user.phone):
                continue
            text = render_report(data, (user.language or "en")[:2])
            await notif.send_sms(
                recipient=user.phone, message=text,
                recipient_role="shift_report", recipient_name=user.name,
            )
            sent += 1
        db.add(ShiftReport(
            shift_key=key, window_start=ws, window_end=we,
            body=render_report(data, "en"),
            machines_included=len(data["machines"]),
            recipients_notified=sent,
            status="sent" if sent else "no_recipients",
        ))
        await db.commit()
        generated += 1
        logger.info("[ShiftReport] %s %s → %s sent to %s recipient(s)", key, ws, we, sent)
    return generated


async def latest_ended_window(db: AsyncSession, now: Optional[datetime] = None):
    """Most recently ended shift window across all machines (for preview/test),
    or None when no machine has a shifts_config."""
    now = now or datetime.now(timezone.utc)
    groups = await _candidate_groups(db, now)
    ended = [(k, g) for k, g in groups.items() if k[2] <= now]
    if not ended:
        return None
    (key, ws, we), g = max(ended, key=lambda kv: kv[0][2])
    return key, ws, we, g["tz"], g["machines"]
