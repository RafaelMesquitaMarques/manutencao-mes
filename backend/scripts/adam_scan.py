"""ADAM-6051 diagnostic scan — find out WHERE your button is wired.

Unlike adam_bench_test.py (which only reads the 12 digital inputs), this probes
several Modbus areas at once and prints ONLY what changes when you act:

  - discrete inputs  DI0..DI11         (FC02)  → the digital-input channels
  - input registers  0..9              (FC04)  → where 32-bit COUNTERS usually live
  - holding registers 0..9             (FC03)  → alternate counter/config location

The ADAM-6051 has 2 hardware counter channels (Counter 0 / Counter 1). A counter
is a 32-bit value = two 16-bit registers (low word + high word). So when you press
your button, watch for either:
  - a DI flipping  (DIx: 1->0), or
  - a register climbing (reg[n]: 5 -> 6)  ← that's a counter counting your pulses

Run:
    python backend/scripts/adam_scan.py --ip 10.0.0.1
Press/release your button a few times. Ctrl+C to stop.
"""
import argparse
import time

from pymodbus.client import ModbusTcpClient

SLAVE_ID = 1


def _read_bits(client, fc, addr, count):
    try:
        rr = fc(address=addr, count=count, device_id=SLAVE_ID)
        if rr.isError():
            return None
        return [1 if b else 0 for b in rr.bits[:count]]
    except Exception:
        return None


def _read_regs(client, fc, addr, count):
    try:
        rr = fc(address=addr, count=count, device_id=SLAVE_ID)
        if rr.isError():
            return None
        return list(rr.registers[:count])
    except Exception:
        return None


def _regs32(regs):
    """Interpret consecutive register pairs as 32-bit counters (low word first)."""
    out = []
    for i in range(0, len(regs) - 1, 2):
        out.append(regs[i] | (regs[i + 1] << 16))
    return out


def snapshot(client):
    return {
        "DI": _read_bits(client, client.read_discrete_inputs, 0, 12),
        "IR": _read_regs(client, client.read_input_registers, 0, 10),
        "HR": _read_regs(client, client.read_holding_registers, 0, 10),
    }


def main():
    ap = argparse.ArgumentParser(description="ADAM-6051 diagnostic scan")
    ap.add_argument("--ip", default="10.0.0.1")
    ap.add_argument("--port", type=int, default=502)
    ap.add_argument("--interval", type=float, default=0.2)
    args = ap.parse_args()

    client = ModbusTcpClient(args.ip, port=args.port, timeout=2)
    print(f"Connecting to ADAM at {args.ip}:{args.port} ...")
    if not client.connect():
        print("  ✗ Could not connect.")
        return
    print("  ✓ Connected.\n")

    first = snapshot(client)
    print("  === initial snapshot ===")
    print(f"  DI (discrete inputs 0-11): {first['DI']}")
    print(f"  IR (input registers 0-9):  {first['IR']}")
    if first["IR"]:
        print(f"       as 32-bit counters:  {_regs32(first['IR'])}")
    print(f"  HR (holding registers 0-9):{first['HR']}")
    if first["HR"]:
        print(f"       as 32-bit counters:  {_regs32(first['HR'])}")
    print("\n  Now press/release your button. Only CHANGES print below:\n")

    prev = first
    try:
        while True:
            cur = snapshot(client)
            for area in ("DI", "IR", "HR"):
                p, c = prev[area], cur[area]
                if p is None or c is None:
                    continue
                for i in range(min(len(p), len(c))):
                    if p[i] != c[i]:
                        print(f"  {area}[{i}]: {p[i]} -> {c[i]}")
            prev = cur
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n  Stopped.")
    finally:
        client.close()


if __name__ == "__main__":
    main()
