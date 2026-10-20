# Deploy: apps01 (Proxmox-VM)

Productie draait op de VM `apps01` (Debian 13, Docker) in `/opt/apps/aquatech`:

| Pad | Inhoud |
|---|---|
| `compose.yml` | kopie van `deploy/apps01/compose.yml` |
| `update.sh` | kopie van `deploy/apps01/update.sh` |
| `.env` | `AQUATECH_TAG`, `TZ`, `TUNNEL_TOKEN`, `COMPOSE_PROFILES=tunnel` (niet in git) |
| `data/` | `/data` van de container (sessiesleutel, back-ups; `aquatech.db` alleen nog als SQLite-terugval) |
| `secrets/master-key` | hoofdsleutel (uid 1000, mode 400; kopie in wachtwoordkluis) |
| `secrets/database-url` | verbindings-URL van Supabase met wachtwoord (uid 1000, mode 400) |
| `pre-update/` | alleen bij SQLite: databasekopie per update (laatste 5) |

## CI/CD

1. Merge naar `master` met een versie-bump in `beregeningsplanner/`.
2. `.github/workflows/release.yml`: tests → image bouwen → smoketest →
   push naar `ghcr.io/danieldh00/aquatech:<versie>` en `:latest`.
3. Op de VM draait `aquatech-update.timer` elke 15 minuten `update.sh`:
   nieuwere versie op `:latest` → back-up (Supabase: `backup.js create` naar
   `data/backups`; SQLite: kopie in `pre-update/`) → container vervangen →
   wachten op healthy, anders automatisch terug naar de vorige versie.

Handmatig: `sudo systemctl start aquatech-update.service` en
`journalctl -u aquatech-update.service -n 20`.

Een specifieke versie terugzetten: `AQUATECH_TAG=<versie>` in `.env`,
`sudo docker compose up -d aquatech`, en `<nieuwere versie>` in
`.failed-version` zetten zodat de timer die niet direct weer uitrolt.

## Supabase (PostgreSQL)

Productie draait sinds 2026-10-20 op Supabase (schema `aquatech`, Session
pooler). `compose.yml` hierboven heeft `DATABASE_URL_FILE` daarom aan.

Overstap (al gedaan; voor een nieuwe server): vanaf de Proxmox-host, of zonder
`ssh` in de console van de VM. Vraagt host van de Session pooler en het
wachtwoord (verborgen) en draait terug naar SQLite als iets misgaat:

```sh
ssh -t root@apps01 'curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01/switch-to-supabase.sh -o /tmp/aquatech-supabase.sh && bash /tmp/aquatech-supabase.sh'
```

Handmatig: zie `beregeningsplanner/DOCS.md` > *Database: Supabase
(PostgreSQL)*. Een mislukte update zet alleen de vorige image terug; de
database blijft in Supabase. Back-ups: dagelijks en vóór elke update
versleuteld in `data/backups`, plus de back-ups van Supabase zelf.

**Terug naar SQLite** (noodgeval): de regel `DATABASE_URL_FILE` in
`compose.yml` uitzetten en `docker compose up -d aquatech`. Zet eerst de
nieuwste back-up terug als `data/aquatech.db` (zie DOCS.md > *Back-ups
terugzetten*), anders mis je alles van na de overstap.

**Wachtwoord van Supabase gewijzigd**: nieuwe URL in `secrets/database-url`
(uid 1000, mode 400) en `docker compose up -d --force-recreate aquatech`.

## Publiek bereikbaar

Cloudflare-tunnel `apps01` (remote-managed, token in `.env`), route
`aquatech.den-hollander.com` → `http://aquatech:3300`.
