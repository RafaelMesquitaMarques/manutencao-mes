"""ADAM-6051 → KAIZO production poller (bench pilot).

Runs on the PC wired to the ADAM. Reads production pulses and feeds the machine's
LIVE STATUS into KAIZO: while pulses keep coming the machine is "running" (green
on the factory map / kiosk); when they stop for `--idle-timeout` seconds it reports
"not producing" and KAIZO flips it to a detected stop (pink) — the exact
signal-driven path in intervention_sync.apply_production_signal().

The bench button is on DI0, active-LOW (idle=1, pressed=0), so one press = one
pulse = one "part". Two pulse SOURCES are supported:

  --source di       (default) software edge-count on a DI channel. Great for the
                    bench; can miss very fast pulses because it polls.
  --source counter  read the ADAM's 32-bit HARDWARE counter register (no missed
                    pulses). Use after you set DI0 -> Counter 0 in the Adam/.NET
                    Utility. --counter-reg is the low-word input-register address.

Setup (once):
    pip install pymodbus            # already done
    # token was provisioned for machine TF-54 (page_slug perc-dri-04)

Run (PowerShell, from C:\\KAIZO):
    $env:ADAM_SIGNAL_TOKEN="vCnmuURBvxZtMj6CIIvMTVMspMlUZw5R"
    python backend/scripts/adam_poller.py

Then watch TF-54 on the factory map: press the button repeatedly -> it goes/stays
green; stop pressing -> after the idle timeout it turns pink with a detected stop.
Ctrl+C to stop.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

from pymodbus.client import ModbusTcpClient

# Keep the ✓ / ● glyphs working even when stdout is redirected (Windows cp1252).
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SLAVE_ID = 1
DI_COUNT = 12


def post_signal(api_base, ref, token, running):
    """POST one production-status reading to KAIZO. Returns the machine status
    string on success, or None on failure (printed, non-fatal)."""
    url = f"{api_base.rstrip('/')}/api/machines/{ref}/production-signal"
    body = json.dumps({"running": running}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Signal-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return data.get("status", "?")
    except urllib.error.HTTPError as e:
        print(f"  ! API {e.code}: {e.read().decode()[:200]}")
    except Exception as e:
        print(f"  ! API unreachable: {e}")
    return None


def post_count(api_base, ref, token, count):
    """POST produced-part pulses to KAIZO (adds to OEE + marks running).
    Returns the response dict on success, or None on failure."""
    url = f"{api_base.rstrip('/')}/api/machines/{ref}/production-count"
    # Send our LOCAL timestamp (with offset) so the server attributes the parts to
    # the same shift/date the operator's kiosk shows (shifts are local wall-clock).
    body = json.dumps({"count": count, "ts": datetime.now().astimezone().isoformat()}).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Signal-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"  ! API {e.code}: {e.read().decode()[:200]}")
    except Exception as e:
        print(f"  ! API unreachable: {e}")
    return None


def read_di(client, channel):
    rr = client.read_discrete_inputs(address=0, count=DI_COUNT, device_id=SLAVE_ID)
    if rr.isError():
        rr = client.read_coils(address=0, count=DI_COUNT, device_id=SLAVE_ID)
    if rr.isError():
        return None
    return 1 if rr.bits[channel] else 0


def read_counter(client, reg):
    """Read a 32-bit counter (low word + high word) from input registers."""
    rr = client.read_input_registers(address=reg, count=2, device_id=SLAVE_ID)
    if rr.isError():
        rr = client.read_holding_registers(address=reg, count=2, device_id=SLAVE_ID)
    if rr.isError():
        return None
    lo, hi = rr.registers[0], rr.registers[1]
    return lo | (hi << 16)


def main():
    ap = argparse.ArgumentParser(description="ADAM-6051 -> KAIZO production poller")
    ap.add_argument("--ip", default="192.168.63.10", help="ADAM IP (default 192.168.63.10)")
    ap.add_argument("--port", type=int, default=502)
    ap.add_argument("--api", default="http://localhost:8000", help="KAIZO API base")
    ap.add_argument("--machine", default="perc-dri-04",
                    help="machine ref = page_slug or UUID (default perc-dri-04 = TF-54)")
    ap.add_argument("--token", default=os.environ.get("ADAM_SIGNAL_TOKEN", ""),
                    help="X-Signal-Token (or set env ADAM_SIGNAL_TOKEN)")
    ap.add_argument("--source", choices=["di", "counter"], default="di")
    ap.add_argument("--channel", type=int, default=0, help="DI channel (source=di)")
    ap.add_argument("--active", choices=["low", "high"], default="low")
    ap.add_argument("--counter-reg", type=int, default=0,
                    help="input-register address of the 32-bit counter (source=counter)")
    ap.add_argument("--interval", type=float, default=0.1, help="poll seconds")
    ap.add_argument("--idle-timeout", type=float, default=15.0,
                    help="seconds without a pulse before reporting 'not producing'")
    args = ap.parse_args()

    if not args.token:
        print("  ✗ No token. Set env ADAM_SIGNAL_TOKEN or pass --token.")
        return

    active_bit = 0 if args.active == "low" else 1

    client = ModbusTcpClient(args.ip, port=args.port, timeout=2)
    print(f"Connecting to ADAM at {args.ip}:{args.port} ...")
    if not client.connect():
        print("  ✗ Could not connect to the ADAM.")
        return
    print(f"  ✓ Connected. Source={args.source}. Machine={args.machine}. "
          f"API={args.api}")
    print(f"  Press the button -> parts count up & TF-54 goes green. "
          f"Idle {args.idle_timeout:.0f}s -> stop. (Ctrl+C to quit)\n")

    parts = 0
    producing = False
    last_pulse = 0.0          # monotonic time of last pulse
    prev_di = None
    prev_counter = None

    def now():
        return time.monotonic()

    try:
        while True:
            pulses = 0
            if args.source == "di":
                cur = read_di(client, args.channel)
                if cur is not None:
                    if prev_di is not None and prev_di != active_bit and cur == active_bit:
                        pulses = 1
                    prev_di = cur
            else:
                cur = read_counter(client, args.counter_reg)
                if cur is not None:
                    if prev_counter is not None and cur >= prev_counter:
                        pulses = cur - prev_counter
                    prev_counter = cur

            if pulses:
                parts += pulses
                last_pulse = now()
                producing = True
                resp = post_count(args.api, args.machine, args.token, pulses)
                if resp:
                    print(f"  ● +{pulses} part(s)  session={parts}  |  TF-54 shift "
                          f"{resp.get('actual_count')}/{resp.get('target_count')}  "
                          f"perf={resp.get('performance_pct')}%  OEE={resp.get('oee_pct')}%")
                else:
                    print(f"  ● +{pulses} part(s)  session={parts}  (API error)")

            if producing and now() - last_pulse > args.idle_timeout:
                producing = False
                status = post_signal(args.api, args.machine, args.token, False)
                print(f"  ⏸ idle {args.idle_timeout:.0f}s -> KAIZO running=False (status: {status})")

            time.sleep(args.interval)
    except KeyboardInterrupt:
        print(f"\n\nStopped. Parts counted this session: {parts}")
    finally:
        client.close()


if __name__ == "__main__":
    main()
