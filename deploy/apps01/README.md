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
| `update/status/` | root, in de container alleen-lezen: `status.json`, `run.json`, `releases.json`, `maintenance.json` (zie `update.sh`) |
| `update/request/` | uid 1000, mode 700: hier zet de app `request.json` (Nu updaten) en `policy.json` (automatisch aan/uit) |

## CI/CD

1. Merge naar `master` met een versie-bump in `hub/`.
2. `.github/workflows/release.yml`: tests → image bouwen → smoketest →
   push naar `ghcr.io/danieldh00/aquatech:<versie>` en `:latest`.
3. Op de VM draait `aquatech-update.timer` elke 15 minuten `update.sh`:
   nieuwere versie op `:latest` → back-up (Supabase: `backup.js create` naar
   `data/backups`; SQLite: kopie in `pre-update/`) → container vervangen →
   wachten op healthy, anders automatisch terug naar de vorige versie.

   Staat *Automatisch bijwerken* in Beheer uit, dan kijkt de timer alleen (en meldt de versie aan de app).
4. **Nu updaten** in Beheer → Systeem → Updates: de app zet `update/request/request.json` neer;
   `aquatech-update.path` start `update.sh` meteen. Die controleert dat de gevraagde versie precies de versie op
   `:latest` is, zet de onderhoudsmodus aan (`update/status/maintenance.json`: de app weigert schrijfverzoeken),
   wacht 10 s, maakt een back-up, wisselt de container en wacht op healthy én de nieuwe versie op `/api/health`.
   Daarna gaat de onderhoudsmodus uit; mislukt het, dan terug naar de vorige versie. De stand staat in
   `update/status/run.json` en komt in het auditlog.

### Updaten vanuit de app inrichten (eenmalig)

Nodig zodra de versie met Beheer → Systeem → Updates draait (de timer installeert die zelf). Vanaf de Proxmox-host:

```sh
ssh -t root@apps01 'curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01/setup-app-update.sh -o /tmp/aquatech-app-update.sh && bash /tmp/aquatech-app-update.sh'
```

Het script haalt `update.sh`, `compose.yml` en `systemd/aquatech-update.{path,service,timer}` uit master (oude
bestanden blijven als `*.bak-<datum>`, het verschil wordt getoond), maakt `update/status` en `update/request`,
zet `aquatech-update.path` aan en maakt de container opnieuw met de twee mappen (lukt dat niet, dan terug naar de
oude `compose.yml`). Controle: `systemctl status aquatech-update.path` en in Beheer → Systeem → Updates staat de
versie. Handmatig hetzelfde: zie de stappen in `setup-app-update.sh`.

Ontwerp en beveiliging: de app krijgt geen Docker-socket en geen root. Ze kan alleen een bestand in
`update/request/` zetten; het script leest daar geen symlinks, maximaal 4 kB, en installeert nooit iets anders dan
wat het zelf uit GHCR haalde. De statusmap is voor de app alleen-lezen. Alleen de beheerder van de hoofdorganisatie
(met multitenancy: een hoofdbeheerder) kan de aanvraag doen, met zijn wachtwoord, hoogstens 5 pogingen per kwartier,
en alles komt in het auditlog.

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

Handmatig: zie `hub/DOCS.md` > *Database: Supabase
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
