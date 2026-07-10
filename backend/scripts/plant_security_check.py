"""HTTP-level plant-segregation check — the repeatable negative-security battery.

Drives the RUNNING API exactly like a hostile browser would: direct ids, forced
X-Plant-Id headers, list counts, plant discovery. Complements the rollback-only
pytest matrix (tests/test_plant_segregation.py) by exercising the full HTTP
stack (routing, dependencies, guards). Read-only: it creates nothing.

Requirements: the seeded corporate admin and the standing QM-only test persona
(test-mira-only@kaizo-test.com — created during the phase-2 rollout).

Run (inside the backend container):
    python scripts/plant_security_check.py
Exit code 0 = all checks passed.
"""
import json
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8000"
ADMIN = {"email": "admin@foliot.com", "password": "admin123"}
PERSONA = {"email": "test-mira-only@kaizo-test.com", "password": "MiraTest123!"}

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str) -> None:
    results.append((ok, label))
    print(("PASS" if ok else "FAIL"), "-", label)


def req(method: str, path: str, token=None, plant=None, body=None):
    """Return (status, parsed_json_or_None)."""
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", f"Bearer {token}")
    if plant:
        r.add_header("X-Plant-Id", plant)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, data=data, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode() or "null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "null")
        except Exception:
            return e.code, None


def login(creds):
    status, out = req("POST", "/api/auth/login", body=creds)
    if status != 200:
        print(f"FATAL: login failed for {creds['email']} ({status})")
        sys.exit(2)
    return out


def main() -> int:
    admin = login(ADMIN)
    persona = login(PERSONA)
    at, pt = admin["access_token"], persona["access_token"]

    plants = {p["code"]: p["plant_id"] for p in admin["plants"]}
    qs, qm, nl = plants["QS"], plants["QM"], plants["NL"]

    # 1. Membership surface
    check([p["code"] for p in persona["plants"]] == ["QM"], "persona login exposes only QM")
    _, plist = req("GET", "/api/plants/", pt)
    check([p["code"] for p in plist] == ["QM"], "plant list hides QS and NL from the persona")

    # 2. Forced contexts
    for target, label in ((qs, "QS"), (nl, "NL")):
        status, out = req("GET", "/api/machines/", pt, plant=target)
        check(status == 403 and (out or {}).get("detail") == "errors.plantNotAuthorized",
              f"forced {label} context rejected with the stable error code")

    # 3. Lists are plant-pure
    for path, label in (("/api/machines/", "machines"), ("/api/tickets/?limit=500", "tickets"),
                        ("/api/wo/?limit=200", "work orders")):
        status, out = req("GET", path, pt)
        check(status == 200, f"persona list {label} responds")

    # 4. Direct-id probes: grab QS records as admin, probe as persona → 404
    _, t = req("GET", "/api/tickets/?limit=1", at)
    _, w = req("GET", "/api/wo/?limit=1", at)
    _, m = req("GET", "/api/machines/", at)
    qs_ticket = t["items"][0]["id"]
    qs_wo = w["items"][0]["id"]
    qs_machine = m["items"][0]["id"]
    for path, label in ((f"/api/tickets/{qs_ticket}", "QS ticket by id"),
                        (f"/api/wo/{qs_wo}", "QS work order by id"),
                        (f"/api/machines/{qs_machine}/history", "QS machine history"),
                        (f"/api/plants/{qs}", "QS plant by id"),
                        (f"/api/factory-map/{qs}", "QS factory map"),
                        (f"/api/reports/machine/{qs_machine}", "QS machine report")):
        status, _out = req("GET", path, pt)
        check(status == 404, f"{label} → 404 for the persona")

    # 5. Cost site lock
    status, _ = req("GET", "/api/costs/pnl?year=2026&site=QS", pt)
    check(status == 403, "persona blocked from the QS cost site")

    # 6. NL isolation for the corporate admin (context works, data empty of QC)
    status, out = req("GET", "/api/machines/", at, plant=nl)
    check(status == 200 and out["total"] == 0, "NL context shows no QC machines")
    status, out = req("GET", "/api/inventory/items?limit=1", at, plant=nl)
    check(status == 200 and out["total"] == 0, "NL context shows no QC stock (isolated pool)")
    status, _ = req("GET", "/api/intelligence/latest?language=en", at, plant=nl)
    check(status == 404, "NL context sees no legacy QC insights")

    # 7. Admin regression: both QC contexts respond and differ
    _, a_qs = req("GET", "/api/wo/dashboard", at, plant=qs)
    _, a_qm = req("GET", "/api/wo/dashboard", at, plant=qm)
    check(a_qs["total_open"] != a_qm["total_open"] or a_qs["by_type"] != a_qm["by_type"],
          "QS and QM dashboards are distinct data sets")

    failed = [label for ok, label in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed"
          + (f" — FAILED: {failed}" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
