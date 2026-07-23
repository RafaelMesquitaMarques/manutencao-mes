"""Simulate the Cortex → KAIZO push (flow 1: cobot reads an OF, Cortex calls
POST /api/v1/cortex/events). Sends a realistic payload and prints the HTTP
status + response envelope, so the integration can be exercised end to end
(auth, validation, idempotency, kiosk live update) before Cortex is connected.

Run inside the backend container (or anywhere with network access to the API):

    # REAL Cobot/Tablette shape (Name/Quantity/SkuNumber/UnitCompletionTime/Machines);
    # --machine accepts a comma-separated list (their Machines is a list)
    docker exec mes_backend python -m scripts.simulate_cortex_push \
        --token dev-token --cobot-format --machine "MACHINE-001,MACHINE-002" --of OF-123456

    # richer proposed envelope
    docker exec mes_backend python -m scripts.simulate_cortex_push \
        --token dev-token --machine MACHINE-001 --of OF-123456 --site QS

    # connectivity/credentials check only
    docker exec mes_backend python -m scripts.simulate_cortex_push --token t --ping

    # idempotency: same eventId delivered twice (2nd answer = duplicate ack)
    ... --token t --machine MACHINE-001 --duplicate

    # error paths
    ... --token t --machine GHOST-01              # MACHINE_NOT_FOUND
    ... --token t --machine MACHINE-001 --invalid # INVALID_PAYLOAD (no orderNumber)
    ... --machine MACHINE-001                     # 401 UNAUTHORIZED (no token)

From the HOST, point --base-url at nginx: --base-url http://localhost.
The token must match CORTEX_INGEST_TOKEN in the backend environment.
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone


def _call(method: str, url: str, token: str | None, body: dict | str | None) -> tuple[int, dict | str]:
    data = None
    if body is not None:
        data = (body if isinstance(body, str) else json.dumps(body)).encode()
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:500]
    except urllib.error.URLError as e:
        print(f"✗ cannot reach {url}: {e.reason}")
        sys.exit(2)


def _print(status: int, body) -> None:
    print(f"HTTP {status}")
    print(json.dumps(body, indent=2, ensure_ascii=False) if isinstance(body, dict) else body)


def main() -> None:
    ap = argparse.ArgumentParser(description="Simulate a Cortex push call")
    ap.add_argument("--base-url", default="http://localhost:8000",
                    help="API base (default: in-container backend; from the host use http://localhost)")
    ap.add_argument("--token", default=None, help="CORTEX_INGEST_TOKEN value (omit to test 401)")
    ap.add_argument("--machine", default="MACHINE-001", help="machineCode (machines.code or page_slug)")
    ap.add_argument("--site", default=None, help="siteCode (plants.code, e.g. SJ) — optional cross-check")
    ap.add_argument("--of", dest="of", default=None, help="orderNumber (default OF-<random>)")
    ap.add_argument("--product-code", default="ITEM-001")
    ap.add_argument("--product-desc", default="Commode 6 tiroirs — chêne")
    ap.add_argument("--qty", type=int, default=100, help="plannedQuantity")
    ap.add_argument("--operation", default="OP-010")
    ap.add_argument("--event-id", default=None, help="eventId (default evt-<uuid>)")
    ap.add_argument("--cobot", default="COBOT-001")
    ap.add_argument("--ping", action="store_true", help="GET /ping and exit")
    ap.add_argument("--duplicate", action="store_true", help="send the same event twice")
    ap.add_argument("--invalid", action="store_true", help="omit orderNumber (INVALID_PAYLOAD path)")
    ap.add_argument("--bad-json", action="store_true", help="send an unparseable body (INVALID_JSON path)")
    ap.add_argument("--cobot-format", action="store_true",
                    help="send the REAL Cobot/Tablette shape (Name/Quantity/SkuNumber/"
                         "UnitCompletionTime/Machines). --machine accepts a comma-separated list")
    ap.add_argument("--unit-time", type=int, default=95, help="UnitCompletionTime (cobot format)")
    args = ap.parse_args()

    base = args.base_url.rstrip("/")

    if args.ping:
        _print(*_call("GET", f"{base}/api/v1/cortex/ping", args.token, None))
        return

    if args.bad_json:
        _print(*_call("POST", f"{base}/api/v1/cortex/events", args.token, "{not json"))
        return

    if args.cobot_format:
        # The shape their system actually sends (C# model, camelCase serialization).
        of = args.of or f"OF-{uuid.uuid4().hex[:6].upper()}"
        payload = {
            "name": of,
            "quantity": args.qty,
            "skuNumber": of,                       # today the SKU = the production number
            "unitCompletionTime": args.unit_time,
            "machines": [m.strip() for m in args.machine.split(",") if m.strip()],
        }
        if args.invalid:
            payload.pop("name")
        print(f"→ POST {base}/api/v1/cortex/events  (cobot format, of={of})")
        _print(*_call("POST", f"{base}/api/v1/cortex/events", args.token, payload))
        if args.duplicate:
            print("\n→ re-pushing the SAME payload (natural idempotency check)")
            _print(*_call("POST", f"{base}/api/v1/cortex/events", args.token, payload))
        return

    now = datetime.now(timezone.utc)
    payload = {
        "eventId": args.event_id or f"evt-{uuid.uuid4().hex}",
        "eventType": "manufacturing_order_scanned",
        "timestamp": now.isoformat().replace("+00:00", "Z"),
        "machineCode": args.machine,
        "cobotCode": args.cobot,
        "manufacturingOrder": {
            "orderNumber": args.of or f"OF-{uuid.uuid4().hex[:6].upper()}",
            "productCode": args.product_code,
            "productDescription": args.product_desc,
            "plannedQuantity": args.qty,
            "completedQuantity": 0,
            "unitOfMeasure": "EA",
            "operationCode": args.operation,
            "operationDescription": "Perçage façade",
            "plannedStartDate": now.isoformat().replace("+00:00", "Z"),
            "plannedEndDate": (now + timedelta(hours=4)).isoformat().replace("+00:00", "Z"),
        },
    }
    if args.site:
        payload["siteCode"] = args.site
    if args.invalid:
        payload["manufacturingOrder"].pop("orderNumber")

    print(f"→ POST {base}/api/v1/cortex/events  (eventId={payload['eventId']})")
    _print(*_call("POST", f"{base}/api/v1/cortex/events", args.token, payload))

    if args.duplicate:
        print("\n→ redelivering the SAME event (idempotency check)")
        _print(*_call("POST", f"{base}/api/v1/cortex/events", args.token, payload))


if __name__ == "__main__":
    main()
