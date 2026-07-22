# Yokogawa Sushi Sensor — integration contract & commissioning runbook

Status **2026-07-16** — infrastructure implemented and simulated end-to-end; awaiting
the physical sensors (arriving ~week of 2026-07-20) to validate the byte-order
assumption and the LoRaWAN join. Sources: Yokogawa *Sushi Sensor Series Software
Edition* **IM 01W06C01-01EN §7** (all frame formats incl. XS530), *XS770A Functions*
**IM 01W06E01-11EN §7**, *XS770A GS* **GS 01W06E01-01EN**, *System Engineering
Guide* **TI 01W06A51-01EN**.

## 1. Hardware on order

| Model code | What it is |
|---|---|
| `XS770A-A3F1-A2CA` | Wireless **vibration** sensor (integrated: 3-axis vibration + surface temp). Area 3 = **US915**, FM nonincendive, battery powered |
| `XS110A-A3F1-A5DA` | Wireless **communication module** (the LoRaWAN radio "head" for XS5xx measurement modules) |
| `XS530-A3F1-H64A-NA` | **Pressure** measurement module (−0.1 to 35 MPa, ½NPT F) — mounts on the XS110A |

**⚠ Missing link: there is no LoRaWAN gateway in this list.** The sensors speak
LoRaWAN (US915, class A) — they cannot reach KAIZO without a gateway + network
server. See §5.

## 2. Architecture

```
XS770A / XS110A+XS530 ──LoRaWAN US915──▶ LoRaWAN gateway ──▶ Network server (NS)
      (class A uplinks)                   (MultiTech/Milesight/RAK…)   (ChirpStack / TTN / embedded NS)
                                                                        │  HTTP integration (webhook)
                                                                        ▼
                                     POST /api/sushi/uplink   (header X-Ingest-Token = SUSHI_INGEST_TOKEN)
                                                                        │  app/services/sushi_service.py
                    ┌───────────────────────────────────────────────────┤
                    ▼                          ▼                        ▼
             sushi_devices (health)     sensors + sensor_readings   alerts (threshold crossings)
             battery/RSSI/diag/tag      (TimescaleDB hypertable)    warning/critical per metric
                    ▼                          ▼                        ▼
        /settings/devices "Sushi"     Equipment → "Condition" tab   condition tab alert list
```

- Readings ride the platform's **existing IoT tables**: one `Sensor` row per metric,
  auto-provisioned with code `SUSHI-{DevEUI}-{VEL|ACC|TEMP|PRESS}[-{X|Y|Z}]`
  (XYZ-composite is the canonical series, no axis suffix).
- Frames only store readings when the device row is **enabled and linked to an
  equipment**; health frames update the device row regardless.
- Unknown DevEUIs are **rejected 404** (fail closed, consistent with the plant-scoping
  rules) — register the device first in `/settings/devices`.

## 3. Uplink payload contract (decoded in `sushi_service.decode_uplink`)

First byte = `Data_Type`. Multi-byte fields **assumed big-endian** (§3.1).
`FLOAT16` = IEEE 754 half precision.

| Data_Type | Frame | Layout after the type byte |
|---|---|---|
| `0x10` | XS770A vibration **Z + temp** | `Data_Status u16` · `PV_Acceleration f16` (m/s², peak) · `PV_Velocity f16` (mm/s, RMS) · `PV_Temperature f16` (°C) |
| `0x11` | XS770A vibration **XYZ + temp** | same as 0x10, composite axes |
| `0x12`/`0x13` | XS770A vibration **X** / **Y** | `Data_Status u16` · `PV_Acceleration f16` · `PV_Velocity f16` (no temp) |
| `0x30` | XS530 **pressure** | `Data_Status u16` · `PV_Pressure f32` (**MPa**) |
| `0x31` | XS530 **temperature** | `Data_Status u16` · `PV_Temperature f32` (°C) |
| `0x40` | Health report (daily) | `UpTime u24` (min) · `BatteryLeft u8` (**value ÷ 2 = %**) · `RSSI u8` (as −dBm) · `PER u8` (%) · `SNR i8` (**value ÷ 4 = dB**) |
| `0x41` | Self-diagnosis | `DIAG_STATUS u32` + `DIAG_DETAIL u32` — NAMUR NE107: bit31 F(ailure) / bit30 C(heck) / bit29 O(ut of spec) / bit28 M(aintenance) |
| `0x42` | Initialization | `Tag_Name` 10 ASCII chars |
| `0x43` | GPS (old XS770A fw) | `lon f32` · `lat f32` |
| `0x44`/`0x45`/`0x46` | Accurate GPS lon/lat/alt | one `f64` each |
| `0x47` | Equipment info | `Vendor u32` · `Dev_Type u16` (2=vibration, 3=temp module, 5=pressure module) · `Dev_Rev u16` |

`Data_Status` bits (measurement frames): bit15/14/13 = acc/vel/temp **error** →
reading stored with `quality='error'` and excluded from alarms; bit12/11/10 =
**overrange** → `quality='estimated'`; bit8 = **simulation mode** → stored, never alarms.
For 0x30/0x31: bit15 = error, bit12 = overrange of that single value.

### 3.1 ⚠ Byte order — TO VERIFY on the first real uplink

The manuals list fields MSB-first but never name an endianness; we default to
**big-endian**. On the first real uplink check the decoded values against the
Sushi Sensor app's display. Garbage values (velocity in the thousands) ⇒ set
`SUSHI_BYTE_ORDER=little` in `.env` and rebuild the backend. One flag flips every
field decoder (`sushi_service._order`).

## 4. Ingest endpoint

`POST /api/sushi/uplink?event=up` — no JWT; auth via header **`X-Ingest-Token`**
matching `SUSHI_INGEST_TOKEN` (.env; already generated for this deployment).
Empty token ⇒ 503 `sushi_ingest_token_not_configured`. Non-`up` events (ChirpStack
join/status/ack) are acknowledged and dropped.

Accepted JSON envelopes (auto-detected, in this order):

1. **ChirpStack v4**: `deviceInfo.devEui`, `data` (base64), `fPort`, `rxInfo[].rssi/snr`, `time`
2. **TTN v3**: `end_device_ids.dev_eui`, `uplink_message.frm_payload` (base64), `rx_metadata`
3. **ChirpStack v3 / Milesight embedded NS**: `devEUI` (hex or base64), `data` (base64), `rxInfo[].rssi/loRaSNR`
4. **Generic / simulator**: `dev_eui` + `payload_hex` (or `frm_payload` base64), optional `rssi`/`snr`/`time`

Errors: 400 `bad_envelope` / `bad_payload` / `unknown_data_type`, 404 `unknown_device`,
401 `invalid_ingest_token`. Gateway-side RSSI/SNR (strongest gateway) win over the
sensor's own daily HRI numbers.

## 5. What to buy/decide before the sensors arrive

Any **US915, 8-channel** LoRaWAN gateway works. Two sane options:

- **Milesight UG65/UG67** — has an **embedded network server** with HTTP push: zero
  extra software; point its HTTP integration at `POST http://<kaizo-host>/api/sushi/uplink`
  with the `X-Ingest-Token` header. Fastest path for a 3-sensor pilot.
- **MultiTech MultiConnect Conduit (IP67)** — the gateway Yokogawa's own engineering
  guide documents (TI 01W06A51-50). Run its embedded NS or forward to ChirpStack.
- Self-hosted **ChirpStack v4** (Docker) is the scalable path if the fleet grows —
  add it to the compose stack later; the endpoint already speaks its webhook format.

Indoor placement near the test machine is fine for the pilot (10 km LoS range;
plant steel will cut that dramatically, still plenty for one building).

## 6. Commissioning runbook (day the hardware arrives)

1. **Gateway**: configure region **US915**, sub-band matching the sensors
   (Yokogawa defaults to sub-band 2 = channels 8–15 on US915 — confirm in the Sushi
   app), connect to plant LAN with a route to the KAIZO host.
2. **NS application**: create an application "KAIZO Sushi", add the HTTP
   integration → URL `http://<host>/api/sushi/uplink`, header
   `X-Ingest-Token: <SUSHI_INGEST_TOKEN from .env>`.
3. **Join keys**: register each sensor in the NS by **DevEUI + AppEUI/JoinEUI + AppKey**.
   Keys are written to the sensor with the **Sushi Sensor Android app over NFC**
   (or the Yokogawa key card). OTAA join; class A.
4. **Sensor config via the app**: set update period (start with **10 min**; 1 h for
   battery-friendly steady state), sending data = **XYZ composite (0x11)** for the
   XS770A, tag name = machine code.
5. **KAIZO**: `/settings/devices` → "Sushi sensors (LoRaWAN)" → *Add* with the same
   DevEUI, pick the machine (equipment), set the update period to match, adjust
   thresholds (defaults: ISO 10816-3 group 2 → warn 4.5 / crit 7.1 mm/s RMS).
6. **Verify**: watch the device row go **online**, open the machine's *Condition*
   tab — values must match the Sushi app's display (§3.1 if not).
7. Mount the XS770A on clean bare metal with the M6 stud (the magnet mount degrades
   the 1 kHz band); XS530 on the process connection; note both are FM-rated for Div 2.

## 7. Demo / test without hardware

```bash
docker exec mes_backend python -m scripts.simulate_sushi --plant QS           # 7-day backfill (2 devices)
docker exec mes_backend python -m scripts.simulate_sushi --plant QS --live   # + fresh uplink every minute
docker exec mes_backend python -m scripts.simulate_sushi --plant QS --http http://localhost:8000  # exercises the real webhook + token
docker exec mes_backend python -m scripts.simulate_sushi --plant QS --reset  # wipe SIM data
docker exec mes_backend python -m pytest tests/test_sushi.py -q              # 22 tests: decoder, envelopes, alarms, health
```

The simulator builds **real binary Yokogawa frames** and pushes them through the
same decoder the hardware will use. SIM devices: `SIM-SUSHI-VIB` (vibration ramp
that crosses the warning threshold in the last day) and `SIM-SUSHI-PRESS`.

## 8. Where things live

- Model: `SushiDevice` in `backend/app/models/models.py` (health + thresholds)
- Decoder/ingest: `backend/app/services/sushi_service.py`
- Routes: `backend/app/api/routes/sushi.py` (uplink + condition read model),
  `sushi_devices.py` (CRUD, guard `settings_devices`)
- UI: `/settings/devices` section "Sushi sensors (LoRaWAN)";
  Equipment detail → **Condition** tab (health cards, trend charts with threshold
  lines, 6h/24h/7d/30d, recent condition alerts)
- Alerts: `alerts` table, types `sushi_vel|sushi_acc|sushi_temp|sushi_press`,
  fired **only on threshold crossings** (prev below → new at/above), never on
  errored/simulated readings. **Hysteresis dead-band on row creation**
  (`_alarm_latched`): a value hovering around a limit re-crosses on nearly
  every uplink, but one alarm episode creates ONE row — it re-arms only after
  the signal clears the limit by 5% (`ALERT_REARM_PCT`, e.g. warn 4.5 → must
  drop below 4.275; pressure-min symmetric on the high side), or after 24 h
  without recovery (`ALERT_LATCH_MAX_HOURS` — a never-clearing condition
  resurfaces daily instead of flooding). The latch is keyed on
  sensor+type+severity+`limit_value`, so pressure min/max stay independent and
  reconfiguring a threshold re-arms immediately. `Alert.created_at` is pinned
  to the reading time (latch + recovery scan share one time axis; backfilled
  alerts land on the historical timeline).
- **SMS/email on critical crossings**: the ingest route fire-and-forgets
  `sushi_service.notify_condition_alerts` → `NotificationService.notify_condition_alert`
  → the plant's **level-0 escalation group** (Settings → Escalation), Twilio SMS +
  (mock) email, logged in `notification_logs` (role `condition_alert`). Guards:
  only `critical` severity pages (warnings stay in-app — `SMS_SEVERITIES`), frames
  older than 15 min never page (replay/backfill safety), **60-min cooldown per
  sensor+severity** (a value hovering on the threshold pages once an hour, not per
  crossing). Template key `condition_alert` (customizable via
  `escalation_settings.sms_templates`); channel toggles via `sms_enabled`/
  `email_enabled` + `channel_matrix['condition_alert']`. The simulator's direct
  backfill bypasses the route → replaying history can never send SMS.
- **Maintenance ticket on critical crossings** (same task, before the SMS):
  `_ensure_condition_ticket` → `TicketService.create_ticket(machine_stopped=False,
  notify=False)` — one ticket (TKT-…) + linked alert (ALT-…) lands in
  **Gestion BT / My Work**, priority `high`, problem type per metric
  (vibration/temp → mechanical, pressure → pneumatic), created_by
  `Capteur <device>`. `machine_stopped=False` = **no waiting intervention, the
  machine keeps running** (kiosk/map untouched); `notify=False` = the ticket
  pipeline's own SMS is skipped so one event pages exactly once (the condition
  SMS, which carries the ticket number: `… → TKT-2026-00032`). The machine's
  existing OPEN ticket is reused (duplicate guard) instead of stacking. The
  normal SLA escalation engine then owns the alert (high = 30-min L1). SMS
  recipients require at least one **level-0 contact** in Settings → Escalation.

## 9. Phase 2 (not built yet)

3D map chip for sushi devices (like the temperature sensors) · battery-low /
NE107 alert rows (today they're badges only — `alerts.sensor_id` is NOT NULL, a
device-level alert needs either a health pseudo-sensor or a nullable column) ·
XS550 temperature module support is already decoded (0x31 path) but untested ·
auto-WO from repeated critical vibration alerts · FFT/waveform detail (needs the
NFC app export, not available over LoRaWAN).
