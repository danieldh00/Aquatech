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
| `compose.localdb.yml` | alleen met eigen PostgreSQL: de database-container naast de app (`.env`: `COMPOSE_FILE=compose.yml:compose.localdb.yml`) |
| `pgdata/` | alleen met eigen PostgreSQL: de databasebestanden (root/uid 999) |
| `secrets/database-url-local` | alleen met eigen PostgreSQL: verbindings-URL van de app naar de eigen database (uid 1000, mode 400) |
| `secrets/postgres-password` | alleen met eigen PostgreSQL: wachtwoord van de databasebeheerder (root, mode 400; de app gebruikt dit niet) |
| `pg-backup.sh`, `backups/postgres/` | alleen met eigen PostgreSQL: dagelijkse versleutelde back-ups (zie hieronder) |
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

## Eigen PostgreSQL (in plaats van Supabase)

De database draait als container `aquatech-postgres` naast de app (PostgreSQL 17, volume `pgdata/`, alleen bereikbaar
via het interne Docker-netwerk, geen gepubliceerde poort). Reden: Supabase telt het dataverkeer naar de app (egress;
gratis plan 5 GB), en de database ernaast kost niets en is sneller. De app merkt geen verschil: dezelfde PostgreSQL,
hetzelfde schema `aquatech`, dezelfde RLS per organisatie (rol `aquatech_app`). De app gebruikt van Supabase alleen de
database (geen auth, storage of realtime).

**Alles wordt bediend vanaf de Proxmox-host** met één script dat de bestanden naar de server kopieert en daar uitvoert
(LXC via `pct exec`, VM via ssh; de server wordt op naam `apps01` gezocht met `pct list`/`qm list`). Er gaan geen
wachtwoorden over de verbinding: de Supabase-URL staat al in `secrets/database-url`, de nieuwe wachtwoorden worden op de
server aangemaakt.

```sh
# Op de Proxmox-host (als root):
curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01/pve/db-local.sh -o /tmp/db-local.sh
bash /tmp/db-local.sh migrate          # Supabase -> eigen PostgreSQL
bash /tmp/db-local.sh status           # waar draait de database, back-ups
bash /tmp/db-local.sh backup           # nu een back-up maken
bash /tmp/db-local.sh restore <bestand>   # een back-up terugzetten
bash /tmp/db-local.sh rollback         # terug naar Supabase (met de nieuwe gegevens)
```

Andere naam of id: `APPS01_NAME`, `APPS01_CTID` (LXC), `APPS01_VMID` (VM) of `APPS01_SSH=root@<ip>`; verder `POSTGRES_TAG`
(standaard 17), `SKIP_HASH=1` (alleen aantallen controleren), `YES=1` (geen bevestigingsvraag), `SRC_DIR` (map
`deploy/apps01` van een lokale checkout in plaats van GitHub).

**Wat `migrate` doet** (de app is ca. 2-10 minuten uit, afhankelijk van de omvang):

1. Installeert `compose.localdb.yml`, `pg-backup.sh` en `aquatech-pg-backup.{service,timer}`, maakt de wachtwoorden en
   start de container (de app blijft intussen gewoon op Supabase draaien).
2. Test de verbinding met Supabase (TLS met controle), controleert de PostgreSQL-versie en maakt een back-up met de app.
3. Zet de onderhoudsmodus aan en stopt de app: vanaf nu wordt er niets meer naar Supabase geschreven.
4. `pg_dump` van schema `aquatech` uit Supabase → `pg_restore` in de eigen database, alles of niets
   (één transactie). Supabase wordt alleen gelezen.
5. Controleert per tabel het aantal rijen én een controlegetal over de inhoud, plus het aantal policies, indexen en tabellen
   met RLS, aan beide kanten. Bij een verschil stopt het.
6. Bewaart een versleutelde laatste momentopname van Supabase (`backups/postgres/supabase-laatste-*.dump.enc`).
7. Zet `COMPOSE_FILE` in `.env` (kopie: `.env.voor-localdb-<datum>`), start de app en controleert: healthy, PostgreSQL,
   RLS actief, de app is echt met de eigen database verbonden.
8. Zet de back-uptimer aan en maakt meteen de eerste back-up.

Gaat in stap 1-7 iets mis, dan zet het script zelf alles terug en start de app weer op Supabase (er is dan niets naar
Supabase geschreven, dus zonder verlies). Wordt de verbinding van de host verbroken, dan loopt het script op de server
door (`systemd-run`); de stand zie je met `status` of `journalctl -u 'aquatech-localdb-*'`.

`update.sh` (de update-timer en *Nu updaten*) blijft werken: het leest `.env` en maakt de back-up vóór een update ook met
`backup.js create`. Alleen de app wordt vervangen, de database-container blijft draaien.

**Back-ups**: elke nacht 02:30 (`aquatech-pg-backup.timer`, `Persistent` = inhalen na een uitgevallen server) maakt
`pg-backup.sh` een `pg_dump` van schema `aquatech`, versleuteld met AES-256 (PBKDF2) met `secrets/master-key` als
wachtwoord, in `backups/postgres/aquatech-<datum>-<tijd>.dump.enc` (map alleen voor root). Elke back-up wordt direct
gecontroleerd (ontsleutelen + inhoudsopgave lezen). Bewaartermijn: dagelijks 14 dagen, de back-ups van zondag 8 weken, de
nieuwste 3 altijd (`KEEP_DAILY_DAYS`, `KEEP_WEEKLY_DAYS`). Plus de back-up van de app zelf in `data/backups`.
**Kopieer `backups/postgres/` ook buiten de server** (bijv. naar de Proxmox-host of een NAS; een back-up op dezelfde schijf
beschermt niet tegen een kapotte schijf) en bewaar `secrets/master-key` in de wachtwoordkluis: zonder die sleutel zijn de
back-ups niet te openen. Voorbeeld vanaf de host: `rsync -a root@apps01:/opt/apps/aquatech/backups/postgres/ /var/backups/aquatech/`.

**Terugdraaien naar Supabase** (`db-local.sh rollback`): maakt eerst een back-up, stopt de app, kopieert de eigen database
naar Supabase (vervangt daar schema `aquatech`, alles of niets, met dezelfde controle per tabel), haalt `COMPOSE_FILE` uit
`.env` en start de app weer op Supabase. Met `rollback --no-copy` alleen de instelling (dan staan de gegevens van na de
overstap alleen in de eigen database). Supabase moet daarvoor nog bestaan: pauzeer of verwijder dat project dus pas na een
paar weken. Handmatig zonder script: `COMPOSE_FILE` uit `.env` halen en `docker compose up -d aquatech`
(`secrets/database-url` is nooit aangepast).

**Opnieuw migreren** na een `rollback`: de eigen database bevat dan al tabellen; het script weigert dat uit voorzorg en
noemt de regel waarmee je bewust opnieuw begint.

**Wachtwoord van de app-rol wijzigen**: `migrate` maakt het eenmalig aan (willekeurig, 64 tekens, alleen in
`secrets/database-url-local`). Nieuw wachtwoord: `ALTER ROLE aquatech PASSWORD '…'` in de container
(`docker exec -it aquatech-postgres psql -U postgres -d aquatech`), dezelfde waarde in `secrets/database-url-local`, en
`docker compose up -d --force-recreate aquatech`.

**Nieuwe hoofdversie van PostgreSQL**: niet automatisch (de image staat op `postgres:17`). Dump met `backup`, zet
`POSTGRES_TAG` in `.env`, verplaats `pgdata/`, start een lege container en `restore` de back-up.

**Op de nieuwe webserver**: kopieer `/opt/apps/aquatech` (of zet een back-up terug met `restore`) en draai `db-local.sh status`
om te controleren; er is niets aan het adres van Supabase of de host gebonden.

## Supabase (PostgreSQL)

Productie draaide sinds 2026-10-20 op Supabase (schema `aquatech`, Session
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
