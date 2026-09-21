# Database backups — check, rehearse, restore

> Runbook for the `backup` service (`mes_backup`). The commands below were run
> verbatim on 2026-09-21 against a real backup: the restore took 24 s with zero
> errors and all 173 tables came back identical to the dump (§7). The
> production-restore steps ran against a stand-in for `mes_db`. Only the
> `docker compose stop/start/up` lines were not run, because they act on the
> live stack. Run the commands in **PowerShell from `C:\KAIZO`**.

---

## 1. What is backed up

| | |
|---|---|
| Database | `manutencao`: all tables, TimescaleDB hypertables and compressed chunks, the continuous aggregate, jobs/policies, RLS policies, grants |
| Tool | `prodrigestivill/postgres-backup-local:16` → `pg_dump` 16, plain SQL, gzip (`*.sql.gz`) |
| When | Every day at 00:00 UTC (20:00 EDT / 19:00 EST). File names use the UTC date |
| Where | `C:\KAIZO\backups\` (bind mount, gitignored). Ordinary Windows files, outside Docker's disk |

| Folder | File name | Kept |
|---|---|---|
| `last\` | `manutencao-YYYYMMDD-HHMMSS.sql.gz` (every run) | 24 hours |
| `daily\` | `manutencao-YYYYMMDD.sql.gz` | 30 days |
| `weekly\` | `manutencao-YYYYWW.sql.gz` (ISO week) | 4 weeks |
| `monthly\` | `manutencao-YYYYMM.sql.gz` | 6 months |

- One run appears in all four folders as NTFS hard links, so the copies cost no
  disk space.
- The `*-latest.sql.gz` entries are Linux symlinks: Windows Explorer shows them
  as 0-byte files. Use the dated files.
- A new run (nightly or manual) **replaces** that day's `daily\` file, that
  week's `weekly\` file and that month's `monthly\` file.
- The folder also holds snapshots taken by hand before risky operations:
  `pre_*.sql` (plain SQL) and `pre_*.dump` (custom format, restored with
  `pg_restore`).

### Not covered

- **Roles.** A single-database dump carries no roles. The app needs one besides
  `mesadmin`: `kaizo_ninja` (Ask Ninja's read-only role). The restore steps
  create it.
- **Uploaded files** (the `uploads_data` volume: PO attachments etc.).
- **`.env`** (database password, API keys). Keep a copy somewhere safe; a new
  machine needs it.
- **Losing the machine or its disk.** The backups sit on the same disk as the
  database. Copy `C:\KAIZO\backups` to another machine on a schedule.

## 2. Check that backups are running

```powershell
docker ps --filter name=mes_backup                   # STATUS: Up … (healthy)
docker exec mes_backup curl -s http://localhost:8080/
Get-ChildItem backups\daily | Sort-Object LastWriteTime | Select-Object -Last 3
```

The `curl` shows the last **scheduled** run: `Exit_status` must be `0` and
`ExitTime` less than about a day old. An empty `ExitTime` only means no
scheduled run has happened since the container started; a manual `/backup.sh`
run does not show up there. The newest `daily\` file should be less than about
24 hours old.

A restart loop with `BACKUP_DIR points to a file or folder with insufficient
permissions` means the container cannot write to its bind mount. Typically it
was created from a checkout on a mapped network drive, which Docker Desktop
cannot mount (this happened from June to September 2026 while it still pointed
at `Z:`). Recreate it from `C:\KAIZO` without touching `db`:

```powershell
docker compose up -d --no-deps backup
```

## 3. Take a backup now

Before a risky operation (import, migration, bulk fix):

```powershell
docker exec mes_backup /backup.sh
```

This also replaces today's `daily\`, `weekly\` and `monthly\` files (§1). To
keep a snapshot outside the rotation instead, follow the `pre_*.dump`
convention:

```powershell
$snap = "pre_import_$(Get-Date -Format yyyyMMdd).dump"   # name it after what you are about to do
docker exec mes_db pg_dump -U mesadmin -Fc -f /tmp/snapshot.dump manutencao
docker cp mes_db:/tmp/snapshot.dump "backups\$snap"
docker exec mes_db rm /tmp/snapshot.dump
```

`pg_dump` warns about `circular foreign-key constraints on this table:
continuous_agg`. That is expected with TimescaleDB and harmless for a full
dump; the nightly runs print it too.

To check that the newest backup is intact, run the command below. Inside the
container the `-latest` link resolves to the newest file; put a dated name
instead to check another one. `gunzip -t` prints nothing when the file is
sound, and the last lines must contain `PostgreSQL database dump complete`:

```powershell
docker exec mes_backup sh -c "gunzip -t /backups/daily/manutencao-latest.sql.gz && zcat /backups/daily/manutencao-latest.sql.gz | tail -n 6"
```

## 4. TimescaleDB version

The server you restore into must run the **same TimescaleDB version** as
production had when the backup was taken, and the dump does not record it.

- Current version (while production is up):
  ```powershell
  docker exec mes_db psql -X -U mesadmin -d manutencao -Atc "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'"
  ```
- It was **2.27.2** on 2026-09-21. It only changes when someone runs
  `ALTER EXTENSION timescaledb UPDATE`; if you do, update this line.
- `timescale/timescaledb:latest-pg16` also carries older versions: 46 of
  them, 2.12.2 to 2.27.2, in the image used on 2026-09-21.
  `CREATE EXTENSION … VERSION` picks one. If a future image no longer has the
  version you need, use the versioned image, e.g.
  `timescale/timescaledb:2.27.2-pg16`.

## 5. Rehearse a restore (drill)

Do it monthly and after any PostgreSQL or TimescaleDB image change. It runs in
a throwaway container with no network and no ports, backups mounted read-only
and background jobs off, and deletes it at the end. Production is not touched.

```powershell
$file = "manutencao-20260921.sql.gz"   # in backups\daily\
$tsdb = "2.27.2"                       # §4

docker run -d --name kaizo_restore_test --network none --cpus 2 --memory 2g `
  -e POSTGRES_USER=mesadmin -e POSTGRES_PASSWORD=drill -e TIMESCALEDB_TELEMETRY=off `
  -v C:\KAIZO\backups:/backups:ro `
  timescale/timescaledb:latest-pg16 postgres -c timescaledb.max_background_workers=0
for ($i = 0; $i -lt 60; $i++) { Start-Sleep 2; docker exec kaizo_restore_test pg_isready -q -h 127.0.0.1 -U mesadmin; if ($LASTEXITCODE -eq 0) { break } }

docker exec kaizo_restore_test psql -X -U mesadmin -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE kaizo_ninja NOLOGIN" -c "CREATE DATABASE manutencao TEMPLATE template0 OWNER mesadmin"
docker exec kaizo_restore_test psql -X -U mesadmin -d manutencao -v ON_ERROR_STOP=1 -c "CREATE EXTENSION timescaledb WITH SCHEMA public VERSION '$tsdb'" -c "SELECT timescaledb_pre_restore()"
docker exec kaizo_restore_test bash -o pipefail -c "gunzip -c /backups/daily/$file | psql -X -U mesadmin -d manutencao -v ON_ERROR_STOP=1 -q -o /dev/null"
docker exec kaizo_restore_test psql -X -U mesadmin -d manutencao -v ON_ERROR_STOP=1 -c "SELECT timescaledb_post_restore()"
```

It passes if no `ERROR` appears anywhere and the load prints nothing. Then
compare a count with production (they differ only by what was written since
the backup) and remove the container:

```powershell
docker exec kaizo_restore_test psql -X -U mesadmin -d manutencao -Atc "SELECT count(*) FROM work_orders"
docker exec mes_db psql -X -U mesadmin -d manutencao -Atc "SELECT count(*) FROM work_orders"
docker rm -f -v kaizo_restore_test
```

Add a line to §7.

## 6. Restore production

Restoring **replaces the whole database**: everything written after the backup
was taken is lost. Pick the newest backup that predates the damage.

```powershell
cd C:\KAIZO
$file = "manutencao-20260921.sql.gz"   # in backups\daily\ (adjust the folder for weekly\, monthly\, last\)
$tsdb = "2.27.2"                       # §4: the version when the backup was taken
```

1. **Copy the backup out of the rotation**, because the next run would replace
   it (§1):
   ```powershell
   New-Item -ItemType Directory -Force backups\restore | Out-Null
   Copy-Item "backups\daily\$file" backups\restore\
   ```
2. **Stop everything that writes to the database** (`db` keeps running):
   ```powershell
   docker compose stop nginx backend iot_worker adam_gateway cortex_poller backup
   ```
3. **Snapshot the current state** (skip if the database is gone; the
   `continuous_agg` warning is expected, see §3):
   ```powershell
   docker exec mes_db pg_dump -U mesadmin -Fc -f /tmp/pre_restore.dump manutencao
   docker cp mes_db:/tmp/pre_restore.dump "backups\pre_restore_$(Get-Date -Format yyyyMMdd).dump"
   docker exec mes_db rm /tmp/pre_restore.dump
   ```
4. **Recreate the database empty and prepare it.** Create the role first, since
   it is not in the dump (`already exists` is fine). Then install TimescaleDB at
   the backup's version, in restoring mode:
   ```powershell
   docker exec mes_db psql -X -U mesadmin -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS manutencao WITH (FORCE)" -c "CREATE DATABASE manutencao TEMPLATE template0 OWNER mesadmin"
   docker exec mes_db psql -X -U mesadmin -d postgres -c "CREATE ROLE kaizo_ninja NOLOGIN"
   docker exec mes_db psql -X -U mesadmin -d manutencao -v ON_ERROR_STOP=1 -c "CREATE EXTENSION timescaledb WITH SCHEMA public VERSION '$tsdb'" -c "SELECT timescaledb_pre_restore()"
   ```
5. **Load the dump.** It takes under a minute and prints nothing when it
   succeeds; any `ERROR` means stop and investigate:
   ```powershell
   docker cp "backups\restore\$file" mes_db:/tmp/restore.sql.gz
   docker exec mes_db bash -o pipefail -c "gunzip -c /tmp/restore.sql.gz | psql -X -U mesadmin -d manutencao -v ON_ERROR_STOP=1 -q -o /dev/null"
   ```
6. **Leave restoring mode and clean up:**
   ```powershell
   docker exec mes_db psql -X -U mesadmin -d manutencao -v ON_ERROR_STOP=1 -c "SELECT timescaledb_post_restore()"
   docker exec mes_db rm /tmp/restore.sql.gz
   ```
7. **Restart the app.** The backend re-applies its idempotent startup DDL:
   ```powershell
   docker compose start nginx backend iot_worker adam_gateway cortex_poller backup
   ```
8. **Check:** log in and open Work Orders, then run:
   ```powershell
   docker exec mes_db psql -X -U mesadmin -d manutencao -Atc "SELECT count(*) FROM work_orders"
   docker exec mes_db psql -X -U mesadmin -d manutencao -Atc "SELECT proc_name, scheduled FROM timescaledb_information.jobs"
   ```

### New machine or lost Docker volume

1. Put the checkout at `C:\KAIZO` (a **local** drive), restore `.env`, and copy
   the backup file into `C:\KAIZO\backups\restore\`.
2. Start only the database with `docker compose up -d db`, then wait until
   `docker exec mes_db pg_isready -h 127.0.0.1 -U mesadmin` answers
   `accepting connections`. Checking over TCP skips the temporary server that
   the first boot runs while it initializes the volume.
3. Set `$file` and `$tsdb` as at the top of this section, then run steps 4–6.
4. Run `docker compose up -d --build`.

## 7. Restore drills

| Date | Backup | Result |
|---|---|---|
| 2026-09-21 | `daily/manutencao-20260921.sql.gz` (24 MB) | Loaded in 24 s with 0 errors and 0 warnings. All 173 tables identical to the dump (281,451 rows). Hypertables, 9/21 compressed chunks, the continuous aggregate, jobs, 45 RLS policies and the `kaizo_ninja` grants identical to production. Sequences ahead of their data |
| 2026-09-21 | same | This runbook's §5 and §6 commands run verbatim in PowerShell. §6 ran against a stand-in for `mes_db` on a brand-new volume with the then-current `scripts/init_db.sql`, which failed its first boot and restarted (fixed the same day). Every step exited 0, 65,843 work orders were restored and all 6 jobs came back scheduled |
