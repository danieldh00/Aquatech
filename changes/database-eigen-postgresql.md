---
titel: Database naar een eigen PostgreSQL naast de app
---

## Nieuws

## Changelog
- Nieuw: `deploy/apps01/compose.localdb.yml` (PostgreSQL 17-container met volume `pgdata/`, healthcheck, geen gepubliceerde poort; de app
  krijgt `secrets/database-url-local`, de Supabase-URL blijft ongemoeid als terugvaloptie), `localdb/local-db.sh` (op de server: `migrate`,
  `rollback`, `backup`, `restore`, `status`) en `pve/db-local.sh` (vanaf de Proxmox-host: zoekt de gast, LXC via `pct exec` of VM via ssh,
  kopieert de bestanden en voert ze uit, via `systemd-run` zodat een verbroken verbinding de migratie niet afbreekt).
- Migratie Supabase → lokaal: app in onderhoudsmodus en gestopt, `pg_dump`/`pg_restore` van schema `aquatech` in één transactie, controle per
  tabel (aantal rijen + controlegetal over de inhoud) plus policies, indexen en RLS-tabellen, versleutelde laatste momentopname van Supabase, daarna
  omzetten via `COMPOSE_FILE` in `.env`. Bij elke fout gaat alles terug naar Supabase (er is dan niets naar Supabase geschreven).
- Dagelijkse versleutelde back-up (`pg-backup.sh`, `aquatech-pg-backup.timer`, 02:30): AES-256 met de hoofdsleutel, direct gecontroleerd,
  bewaartermijn 14 dagen (zondag 8 weken, nieuwste 3 altijd). Terugzetten met `db-local.sh restore`.
- Terugdraaien naar Supabase met de nieuwe gegevens (`rollback`) of alleen de instelling (`rollback --no-copy`).
- Documentatie in `deploy/apps01/README.md`, `hub/DOCS.md`, `CLAUDE.md` en `README.md`; test `deploy-localdb.test.js` bewaakt de scripts.
