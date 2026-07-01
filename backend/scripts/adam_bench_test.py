"""ADAM-6050 bench test — read the 12 digital inputs over Modbus/TCP and watch
them react when you trigger a channel by hand. NO machine needed: this is the
embryo of the future poller, used to validate the device on the bench first.

What it does, in a loop:
  - connects to the ADAM over Modbus/TCP (port 502)
  - reads the 12 digital inputs (DI0..DI11)
  - prints each channel as 0/1
  - counts rising edges in software (0->1) per channel, so you can SEE a count
    climb when you trigger an input — exactly what one "production pulse" will do

Bench wiring to trigger an input by hand (dry-contact mode):
  briefly jumper the DI channel terminal to the DI common/GND. Each touch =
  one 0->1->0, i.e. the edge counter for that channel goes up by 1.

Setup:
    pip install pymodbus
Run (Windows / any OS):
    python adam_bench_test.py --ip 10.0.0.1
Stop with Ctrl+C.

NOTE on production counting: this script counts edges in SOFTWARE by polling,
which is perfect for a bench demo. On the real machine, for fast pulses, the
right source is the ADAM's built-in HARDWARE counter (read via Modbus
registers) so no pulse is missed between polls. We wire that into the real
poller later; for the bench, software edge-counting is all you need to see it work.
"""
import argparse
import time

# pymodbus 3.x
from pymodbus.client import ModbusTcpClient

# ADAM-6050 Modbus map: the 12 digital inputs are discrete inputs at address 0.
DI_START = 0
DI_COUNT = 12
SLAVE_ID = 1   # ADAM unit/slave id (usually 1)


def main():
    ap = argparse.ArgumentParser(description="ADAM-6050 bench test")
    ap.add_argument("--ip", default="10.0.0.1", help="ADAM IP (default 10.0.0.1)")
    ap.add_argument("--port", type=int, default=502, help="Modbus TCP port (default 502)")
    ap.add_argument("--interval", type=float, default=0.2, help="poll interval seconds (default 0.2)")
    args = ap.parse_args()

    client = ModbusTcpClient(args.ip, port=args.port, timeout=2)
    print(f"Connecting to ADAM at {args.ip}:{args.port} ...")
    if not client.connect():
        print("  ✗ Could not connect. Check: cable, ADAM power, your PC IP is on "
              "the same subnet (e.g. 10.0.0.100/255.0.0.0), and `ping` works.")
        return
    print("  ✓ Connected. Reading DI0..DI11. Trigger a channel by hand to see it react.")
    print("  (Ctrl+C to stop)\n")

    prev = [0] * DI_COUNT          # last state per channel (for edge detection)
    edges = [0] * DI_COUNT         # rising-edge count per channel

    try:
        while True:
            rr = client.read_discrete_inputs(address=DI_START, count=DI_COUNT, slave=SLAVE_ID)
            if rr.isError():
                # Some ADAM units expose DI as coils instead — fall back to FC01.
                rr = client.read_coils(address=DI_START, count=DI_COUNT, slave=SLAVE_ID)
            if rr.isError():
                print(f"  read error: {rr}. Try the Adam/.NET Utility to confirm the unit responds.")
                time.sleep(1)
                continue

            bits = [1 if b else 0 for b in rr.bits[:DI_COUNT]]
            for ch in range(DI_COUNT):
                if prev[ch] == 0 and bits[ch] == 1:   # rising edge = one "pulse"
                    edges[ch] += 1
                prev[ch] = bits[ch]

            states = " ".join(f"DI{ch}:{bits[ch]}" for ch in range(DI_COUNT))
            counts = " ".join(f"c{ch}={edges[ch]}" for ch in range(DI_COUNT) if edges[ch])
            print(f"\r{states}   | edges: {counts or '-'}        ", end="", flush=True)
            time.sleep(args.interval)
    except KeyboardInterrupt:
        print("\n\nStopped. Final edge counts:")
        for ch in range(DI_COUNT):
            print(f"  DI{ch}: {edges[ch]} rising edge(s)")
    finally:
        client.close()


if __name__ == "__main__":
    main()
