# Operations runbook

For whoever runs a Jorcord instance on the Oracle Cloud Always Free VM described in [DEPLOY-FREE.md](./DEPLOY-FREE.md) (one Ampere A1 VM, `docker compose`, Caddy for HTTPS). Commands assume the repo is checked out at `~/Jorcord` on the VM and the compose project is named `jorcord` (the default). Placeholders: `<ip>` public IP, `<ocid>` instance OCID. Nothing here contains secrets; they live in `~/Jorcord/.env` on the VM.

OCI console wording changes over time: check the current [OCI docs](https://docs.oracle.com/en-us/iaas/Content/Compute/home.htm) if a menu is not where this says.

## 1. Health checks (start here)

From anywhere:

```bash
curl -fsS https://jorcord.duckdns.org/health            # {"status":"ok","db":"pg"} ; 503 {"status":"degraded"} = database down
curl -sI https://jorcord.duckdns.org | head -n 5         # 200 + HSTS means Caddy and the server are up
```

On the VM (`ssh ubuntu@<ip>`):

```bash
cd ~/Jorcord
docker compose ps                                         # every service Up; postgres and redis (healthy)
docker compose logs --tail=100 server                     # boot, "applied migration ..." lines, errors (JSON, pino)
docker compose exec postgres psql -U jorcord -d jorcord -c "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 5"
docker compose exec postgres psql -U jorcord -d jorcord -c "SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE NOT i.indisvalid"   # must return no rows
df -h / ; free -m ; uptime                                # disk full is the usual silent killer of Postgres
sudo iptables -L INPUT -n --line-numbers | head -n 20     # 80, 443, 7881 tcp and 7882, 3478 udp still accepted
```

Voice: join a channel from a phone on mobile data. If it hangs on "Connecting...", check the OCI security list and iptables for 7881/tcp and 7882/udp, and `docker compose logs livekit`.

## 2. Deploy over ssh

Normal release (the compose file pulls `ghcr.io/hishamabulfeilat/jorcord-server:${JORCORD_VERSION:-latest}`):

```bash
ssh ubuntu@<ip>
cd ~/Jorcord
git fetch origin && git status -sb                       # clean tree expected; .env is untracked
git log --oneline -1                                      # note the commit you are leaving, for rollback
git checkout <tag-or-sha>                                 # e.g. v1.3.0; compose/config changes ship with the repo
docker compose pull                                       # new image (set JORCORD_VERSION=1.3.0 in .env to pin a version)
docker compose exec -T postgres pg_dump -U jorcord jorcord | gzip > ~/backups/pre-deploy-$(date +%F-%H%M).sql.gz   # see section 4
docker compose up -d                                      # recreates only what changed; migrations run at server boot
docker compose logs -f --tail=50 server                   # wait for "applied migration" lines and the listen line, Ctrl-C
curl -fsS localhost:3000/health
```

Building from source instead (`docker compose up -d --build`) works but needs a few GB of RAM and several minutes on the A1 shape. If you use the single-VM override with the bundled Caddy, add `-f docker-compose.yml -f docker-compose.prod.yml` to every `docker compose` command (and `DOMAIN` in `.env`).

Never run two different versions against the same database for long: start one node first, let it migrate, then the others (see DEPLOY.md, multi-node).

## 3. Rollback to a previous commit

Migrations are forward-only and additive, so older code normally runs fine on a newer schema. Order of preference:

1. **Code only (normal case):** go back to the commit or tag you noted before the deploy.
   ```bash
   cd ~/Jorcord
   git checkout <previous-sha-or-tag>
   # if you pin versions: set JORCORD_VERSION=<previous version> in .env
   docker compose pull && docker compose up -d
   curl -fsS localhost:3000/health
   ```
   Do not delete rows from `schema_migrations`: the old code ignores unknown migrations, and re-adding the new code later must not re-run them.
2. **Bad migration (data damaged or old code cannot read the schema):** stop the server (`docker compose stop server`), restore the pre-deploy dump from section 4 into a fresh database, check out the previous commit, start the server. You lose everything written since the dump; say so to users.
3. **Source control:** to undo a change on the repo itself use `git revert <sha>` on a branch and open a PR. Do not force-push and do not rewrite `main`.

## 4. Backup and restore

What holds state: the Postgres volume (`jorcord_pg-data`), the files volume (`jorcord_server-data`, uploads when `STORAGE_DRIVER=local`), and `.env` (secrets: keep an encrypted copy elsewhere; losing `JWT_SECRET` logs everyone out and breaks MFA enrolments). Redis holds nothing that must survive.

Backup (run from cron, daily, keep 7 to 14 copies, copy off the VM, for example to Object Storage; the free tier includes some):

```bash
mkdir -p ~/backups && cd ~/Jorcord
docker compose exec -T postgres pg_dump -U jorcord jorcord | gzip > ~/backups/db-$(date +%F).sql.gz
docker run --rm -v jorcord_server-data:/data -v ~/backups:/backup alpine tar czf /backup/files-$(date +%F).tar.gz -C /data .
find ~/backups -type f -mtime +14 -delete
```

Also take a boot volume backup before risky changes: Console > Compute > Instance > Boot volume > Boot volume backups > Create (or a Block Volume backup policy for scheduled ones).

Restore into the running stack (this replaces the data):

```bash
cd ~/Jorcord
docker compose stop server
docker compose exec -T postgres psql -U jorcord -d postgres -c "DROP DATABASE jorcord WITH (FORCE)" -c "CREATE DATABASE jorcord OWNER jorcord"
gunzip -c ~/backups/db-<date>.sql.gz | docker compose exec -T postgres psql -U jorcord -d jorcord
docker run --rm -v jorcord_server-data:/data -v ~/backups:/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/files-<date>.tar.gz -C /data"
docker compose up -d server
curl -fsS localhost:3000/health
```

Test a restore on a scratch machine at least once; an untested backup is a hope.

## 5. Oracle free-tier recovery

### 5.1 Instance stuck in "Stopping" (or "Starting")

1. Wait. A clean stop can take several minutes; give it 15 minutes before acting.
2. Check the instance **Work requests** (Console > Compute > Instance > Work requests) for an error, and the **Console connection** (serial console) if SSH is dead but the instance says Running.
3. **Force a reset** from the instance page: More actions > **Reboot** with the force option ("Force reboot"), or from the CLI:
   ```bash
   oci compute instance action --instance-id <ocid> --action RESET          # hard power cycle, like pulling the plug
   oci compute instance get --instance-id <ocid> --query 'data."lifecycle-state"'
   ```
   For a stuck stop, `--action STOP` with `--force`/`--action-type` variants may be offered by your CLI version (`oci compute instance action --help`). A hard reset is safe for Postgres (it recovers from its write-ahead log) but check section 1 afterwards.
4. Still stuck after another 15 to 30 minutes: open a support request from the same page (Always Free accounts can still use the community forums and in-console chat where offered) and move to 5.2 to bring the data to a new VM.

### 5.2 Boot volume rescue (instance will not boot, lost SSH access, full disk, broken fstab or firewall)

1. Console > Compute > Instance > **Boot volume**: note its name. Stop the instance (use the force option if needed).
2. **Detach** the boot volume from the broken instance (Instance > Boot volume > Detach). It is not deleted.
3. Create a small rescue instance (same availability domain; Ubuntu, any free shape such as `VM.Standard.E2.1.Micro`, or a second A1 if you have quota) and **Attach block volume** > the old boot volume as a secondary disk (paravirtualized is simplest).
4. On the rescue VM:
   ```bash
   lsblk                                   # find the old volume, e.g. sdb with partitions sdb1 (EFI) and sdb15/sdb1 (root)
   sudo mkdir -p /mnt/rescue && sudo mount /dev/sdb1 /mnt/rescue     # use the large ext4 partition
   sudo du -xh /mnt/rescue/var/lib/docker --max-depth=1 | sort -h | tail     # disk full? prune or move big logs
   sudo nano /mnt/rescue/etc/fstab         # comment out any line for a device that no longer exists (use nofail)
   sudo tee -a /mnt/rescue/home/ubuntu/.ssh/authorized_keys < ~/new_key.pub   # restore access with a key you hold
   sudo umount /mnt/rescue
   ```
   To copy data off instead of repairing: `sudo rsync -a /mnt/rescue/var/lib/docker/volumes/jorcord_pg-data/ ...` is not crash-consistent; prefer repairing and booting, then taking a `pg_dump`.
5. Detach the volume from the rescue VM, **reattach it as the boot volume** of the original instance (Instance > Boot volume > Attach boot volume), start the instance, and run the checks in section 1.
6. If the instance cannot be repaired: create a new A1 instance **from the boot volume** (Boot volume > Create instance, or Create boot volume backup first and create from the backup), keeping the same reserved public IP (move the Reserved Public IP to the new VNIC) or update the DuckDNS record. A1 capacity is sometimes "out of capacity": retry later or in another availability domain; do not delete the old boot volume until the new VM is verified.

### 5.3 Lost the public IP or DNS

Reserved public IP (Networking > IP management) survives instance replacement; reassign it to the new VNIC. Otherwise update the DuckDNS record, wait for DNS, then restart Caddy so it can issue a certificate: `docker restart caddy` and `docker logs caddy --tail 50`.

### 5.4 Host rebooted and the stack did not return

Services use `restart: unless-stopped`, so they come back with Docker. If not: `sudo systemctl status docker`, `docker compose ps`, `docker compose up -d`. Check that the iptables rules persisted (`sudo netfilter-persistent save` after changes), otherwise 80/443 and the LiveKit ports are closed after the reboot.

## 6. Safe database migrations (index changes on a live database)

`apps/server/src/db/migrate.ts` runs each `*.sql` migration inside one transaction and records it in `schema_migrations` (by file name, there are no checksums). A plain `CREATE INDEX` therefore blocks writes to the table for the whole build, which can be minutes on a large `messages` table.

Rules for new migrations:

- **Index-only migrations must be named `NNN_name.concurrent.sql`.** On Postgres the runner executes them statement by statement outside a transaction, so `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` works and takes no write lock. The file may contain only `CREATE [UNIQUE] INDEX CONCURRENTLY IF NOT EXISTS ...` and `DROP INDEX CONCURRENTLY IF EXISTS ...` statements (the runner rejects anything else). If a run dies mid-build it leaves an INVALID index; the runner drops and rebuilds it on the next boot. Embedded PGlite (tests, dev) strips `CONCURRENTLY` and runs the file transactionally.
- Do not mix index builds with table changes in one file: put `ALTER TABLE`/data changes in a normal `.sql` migration and the indexes in a `.concurrent.sql` one with the next number.
- Other lock-prone changes (adding a `NOT NULL` column with a default on a big table, `ALTER TYPE`, validating a foreign key) belong in their own migration, ideally with `ADD COLUMN` first and a backfill in batches afterwards.
- Migration numbers `043`-`048` are unused on purpose (reserved by parallel work); keep numbers unique and increasing, because files apply in name order.
- `041_perf_indexes.sql` was renamed to `041_perf_indexes.concurrent.sql` (statements now use `CONCURRENTLY`). A database that already applied the old name runs the new file once at the next boot, where every statement is a no-op because the indexes exist; a fresh database builds them without a write lock.

Before a migration that touches a large table: take a backup (section 4), run it first on a restored copy to time it, and deploy during low traffic.
