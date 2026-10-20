# Deploy: apps01 (Proxmox-VM)

Productie draait op de VM `apps01` (Debian 13, Docker) in `/opt/apps/aquatech`:

| Pad | Inhoud |
|---|---|
| `compose.yml` | kopie van `deploy/apps01/compose.yml` |
| `update.sh` | kopie van `deploy/apps01/update.sh` |
| `.env` | `AQUATECH_TAG`, `TZ`, `TUNNEL_TOKEN`, `COMPOSE_PROFILES=tunnel` (niet in git) |
| `data/` | `/data` van de container (database, sessiesleutel, back-ups) |
| `secrets/master-key` | hoofdsleutel (uid 1000, mode 400; kopie in wachtwoordkluis) |
| `secrets/database-url` | alleen met Supabase: verbindings-URL met wachtwoord (uid 1000, mode 400) |
| `pre-update/` | databasekopie per update (laatste 5) |

## CI/CD

1. Merge naar `master` met een versie-bump in `beregeningsplanner/`.
2. `.github/workflows/release.yml`: tests → image bouwen → smoketest →
   push naar `ghcr.io/danieldh00/aquatech:<versie>` en `:latest`.
3. Op de VM draait `aquatech-update.timer` elke 15 minuten `update.sh`:
   nieuwere versie op `:latest` → databasekopie → container vervangen →
   wachten op healthy, anders automatisch terug naar de vorige versie.

Handmatig: `sudo systemctl start aquatech-update.service` en
`journalctl -u aquatech-update.service -n 20`.

Een specifieke versie terugzetten: `AQUATECH_TAG=<versie>` in `.env`,
`sudo docker compose up -d aquatech`, en `<nieuwere versie>` in
`.failed-version` zetten zodat de timer die niet direct weer uitrolt.

## Supabase (PostgreSQL)

Overstappen: zie `beregeningsplanner/DOCS.md` > *Database: Supabase
(PostgreSQL)*. Daarna staat de database niet meer in `data/`: de
databasekopie in `pre-update/` van `update.sh` geldt alleen voor SQLite; een
terugval na een mislukte update zet dan alleen de vorige image terug. De
versleutelde dagelijkse back-ups in `data/backups` lopen gewoon door.

## Publiek bereikbaar

Cloudflare-tunnel `apps01` (remote-managed, token in `.env`), route
`aquatech.den-hollander.com` → `http://aquatech:3300`.
