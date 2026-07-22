"""AI-assisted failure-mode labeling of the corrective-WO history.

The 3-year corrective history is the platform's most valuable predictive
asset, but `failure_code`/`component` are sparsely filled on old work orders.
This script classifies each failure_event's source text (WO title/description/
root cause/solution) into a fixed failure-mode taxonomy + a short component
label, writing ONLY to the derived `failure_events` table (sources untouched):

  failure_type      ← taxonomy code (only when empty or previously AI-labeled)
  component         ← short component text (same rule)
  label_source      ← 'ai'   (human edits via the /predictive failures screen
                              set 'human' and are never overwritten)
  label_confidence  ← model-reported 0..1

Progress is checkpointed by label_source, so re-runs continue where they left
off. Uses the platform's Anthropic key (same as the note organizer); without a
key the script exits without touching anything.

Run inside the backend container:
    python -m scripts.label_failure_history --limit 50 --dry-run   # inspect first
    python -m scripts.label_failure_history --limit 50             # write batch
    python -m scripts.label_failure_history --all                  # full history
"""
import argparse
import asyncio
import json
import re

from anthropic import AsyncAnthropic
from sqlalchemy import select

from app.core.config import settings
from app.db.session import AsyncSessionLocal
from app.models.models import FailureEvent, FailureSource, MaintenanceTicket, WorkOrder

MODEL = "claude-haiku-4-5-20251001"
BATCH = 10          # events per API call
MIN_TEXT_LEN = 8    # skip events with no usable text

TAXONOMY = [
    "bearing", "motor_electrical", "electrical_control", "hydraulic", "pneumatic",
    "lubrication", "mechanical_wear", "belt_chain", "alignment_vibration",
    "tooling_blade", "jam_material", "overheating", "sensor_instrumentation",
    "structural", "leak", "software_plc", "operator_related", "unknown",
]

SYSTEM = f"""You classify industrial maintenance work orders (furniture factory; text is French or English) into failure modes.
For each numbered item, output a JSON array entry: {{"i": <number>, "mode": <one of {json.dumps(TAXONOMY)}>, "component": <short component name in French, max 6 words, or null>, "confidence": <0.0-1.0>}}.
Use "unknown" with low confidence when the text is too vague. Output ONLY the JSON array, nothing else."""


def _wo_text(wo: WorkOrder, ticket: MaintenanceTicket | None = None) -> str:
    parts = [wo.title, wo.short_description, wo.description, wo.root_cause,
             wo.solution_applied, wo.failure_code, wo.component]
    # Kiosk-born WOs are just a pointer — the substance (operator description,
    # technician diagnosis and corrective action) lives on the linked ticket.
    if ticket is not None:
        parts += [ticket.description, ticket.diagnosis, ticket.corrective_action]
    return " | ".join(p.strip() for p in parts if p and p.strip())[:600]


async def _classify(client: AsyncAnthropic, items: list[tuple[int, str]]) -> dict[int, dict]:
    body = "\n".join(f"{i}. {text}" for i, text in items)
    resp = await client.messages.create(
        model=MODEL, max_tokens=1500, temperature=0.0,
        system=SYSTEM,
        messages=[{"role": "user", "content": body}],
    )
    raw = "".join(b.text for b in resp.content if b.type == "text")
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        return {}
    out = {}
    for entry in json.loads(match.group(0)):
        mode = entry.get("mode")
        if mode in TAXONOMY:
            out[int(entry["i"])] = {
                "mode": mode,
                "component": (entry.get("component") or None),
                "confidence": max(0.0, min(1.0, float(entry.get("confidence") or 0.0))),
            }
    return out


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=50)
    ap.add_argument("--all", action="store_true", help="ignore --limit, label the whole backlog")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not settings.anthropic_api_key:
        raise SystemExit("ANTHROPIC_API_KEY not configured — nothing to do.")
    client = AsyncAnthropic(api_key=settings.anthropic_api_key, timeout=60, max_retries=2)

    labeled = skipped = 0
    async with AsyncSessionLocal() as s:
        stmt = (
            select(FailureEvent, WorkOrder, MaintenanceTicket)
            .join(WorkOrder, WorkOrder.id == FailureEvent.source_id)
            .outerjoin(MaintenanceTicket, MaintenanceTicket.id == WorkOrder.ticket_id)
            .where(
                FailureEvent.source == FailureSource.work_order,
                FailureEvent.label_source.is_(None),
            )
            .order_by(FailureEvent.started_at.desc())
        )
        if not args.all:
            stmt = stmt.limit(args.limit)
        rows = (await s.execute(stmt)).all()
        print(f"{len(rows)} unlabeled work-order failure events to process.")

        pending: list[tuple[int, str]] = []
        by_idx: dict[int, FailureEvent] = {}

        async def flush() -> None:
            nonlocal labeled, skipped
            if not pending:
                return
            try:
                results = await _classify(client, pending)
            except Exception as exc:  # noqa: BLE001 — one bad batch must not kill the run
                print(f"  batch failed ({exc}) — skipping {len(pending)} events")
                pending.clear()
                return
            for i, _text in pending:
                ev = by_idx[i]
                res = results.get(i)
                if res is None:
                    skipped += 1
                    continue
                if args.dry_run:
                    print(f"  [dry] {str(ev.source_id)[:8]} → {res['mode']}"
                          f" / {res['component'] or '—'} ({res['confidence']:.2f})")
                else:
                    if not ev.failure_type or ev.label_source == "ai":
                        ev.failure_type = res["mode"]
                    if (not ev.component or ev.label_source == "ai") and res["component"]:
                        ev.component = res["component"][:200]
                    ev.label_source = "ai"
                    ev.label_confidence = res["confidence"]
                labeled += 1
            if not args.dry_run:
                await s.commit()
            pending.clear()

        for idx, (ev, wo, ticket) in enumerate(rows):
            # WOs that already carry a structured failure code keep it — just
            # stamp provenance so the checkpoint moves past them.
            if wo.failure_code and ev.failure_type:
                if not args.dry_run:
                    ev.label_source = "source"
                    ev.label_confidence = 1.0
                continue
            text = _wo_text(wo, ticket)
            if len(text) < MIN_TEXT_LEN:
                if not args.dry_run:
                    ev.label_source = "ai"
                    ev.failure_type = ev.failure_type or "unknown"
                    ev.label_confidence = 0.0
                skipped += 1
                continue
            pending.append((idx, text))
            by_idx[idx] = ev
            if len(pending) >= BATCH:
                await flush()
        await flush()
        if not args.dry_run:
            await s.commit()

    print(f"Done: {labeled} labeled, {skipped} skipped/no-text.")


if __name__ == "__main__":
    asyncio.run(main())
