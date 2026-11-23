#!/usr/bin/env bash
# Vaste servertaken voor Aquatech op apps01: bediening VANAF DE PROXMOX-HOST (pve), als root.
#
#   bash servertaken.sh                  status (standaard): alleen lezen, met samenvatting
#   bash servertaken.sh status           idem
#   bash servertaken.sh logs [uren]      alle [traag]- en [stilstand]-regels van de app (standaard 24 uur)
#   bash servertaken.sh migraties        controleert de databaseversie; loopt hij achter, dan de app herstarten (migreren)
#   bash servertaken.sh update           nu updaten naar de nieuwste versie in GHCR (met back-up en terugval)
#   bash servertaken.sh schijf           toont wat de schijf vult en ruimt na bevestiging op (oude app-images, build-cache, journal)
#                                        en werkt update.sh op de server bij (met UPDATE_SH_REF=<volledige commit>; zonder blijft hij ongemoeid)
#   bash servertaken.sh openstaand       voert alle nog openstaande servertaken uit (de afvinklijst in Beheer > Systeem > Updates)
#                                        en onthoudt op de server welke gedaan zijn (met TASKS_REF=<volledige commit>)
#   bash servertaken.sh help             deze uitleg
#
# Servertaken (openstaand): de lijst staat in de app (hub/backend/src/platform/host-tasks.js, `HOST_TASKS`); elke taak heeft
# hieronder een functie `hosttask_<id met underscores>`. Een nieuwe taak = één regel in HOST_TASKS én één functie hier (en
# een regel in HOST_TASK_IDS). Wat gedaan is, staat in update/status/host-tasks.json (de app leest dat en vinkt af).
# Het vaste commando voor Daniël staat in de app; het haalt de nieuwste master-commit op en gebruikt die als TASKS_REF.
#
# Opties: --yes (of YES=1) = geen bevestigingsvraag (voor automatisering). `migraties` en `update` herstarten de app,
# `schijf` verwijdert oude images; ze vragen daarom eerst om bevestiging; `status` en `logs` wijzigen niets.
#
# Zonder download, rechtstreeks van GitHub:
#   curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01/pve/servertaken.sh -o /tmp/servertaken.sh
#   bash /tmp/servertaken.sh status
#
# Het script zoekt het gast-systeem `apps01` op de host (LXC via `pct exec`, VM of gewone host via ssh), net als
# db-local.sh, en voert zichzelf daar uit (het eigen bestand gaat via stdin mee; er wordt niets op de server geïnstalleerd).
# Er gaan geen wachtwoorden of geheimen over de verbinding en geen geheimen in de uitvoer (.env en secrets/ worden
# niet getoond; alleen het versienummer uit .env wordt gelezen).
#
# Hoe het zich verhoudt tot het bestaande systeem:
#   - update: dezelfde service als de timer en de knop Nu updaten (aquatech-update.service → update.sh: onderhoudsmodus,
#     back-up, wisselen, healthcheck, terugval). Staat automatisch bijwerken in de app uit, dan zet dit script een
#     aanvraag klaar zoals de app dat doet (update/request/request.json, alleen voor de versie die op :latest staat).
#   - migraties: de app migreert zelf bij het starten (alleen toevoegen). Dit script toont de versie in de database
#     tegenover de versie die de draaiende app verwacht en herstart de app (na een back-up) als de database achterloopt.
#
# Instellingen (omgevingsvariabelen, allemaal optioneel):
#   APPS01_NAME  naam van het gast-systeem in Proxmox (standaard apps01)
#   APPS01_CTID  vaste LXC-id          APPS01_VMID  vaste VM-id          APPS01_SSH  ssh-doel, bijv. daniel@apps01 (sudo -n)
#   APP_DIR      map op de server (standaard /opt/apps/aquatech)
#   LOG_SINCE    hoe ver terug de app-log wordt gelezen bij status (standaard 24h)
#   YES=1        geen bevestigingsvraag
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech}"

# =====================================================================================================================
# Deel 1: draait OP DE SERVER (apps01). Het host-deel hieronder stuurt dit bestand met SERVERTAKEN_REMOTE=1 erheen.
# =====================================================================================================================
IMAGE="ghcr.io/danieldh00/aquatech"
VERSION_RE='^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'
OK_COUNT=0; WARN_COUNT=0; FAIL_COUNT=0

log() { echo "[$(date '+%F %T')] $*"; }
ok() { OK_COUNT=$((OK_COUNT + 1)); printf '  [ OK ] %s\n' "$*"; }
warn() { WARN_COUNT=$((WARN_COUNT + 1)); printf '  [WARN] %s\n' "$*"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '  [FOUT] %s\n' "$*"; }
info() { printf '         %s\n' "$*"; }
section() { printf '\n== %s ==\n' "$*"; }
env_get() { sed -n "s/^$1=//p" "$APP_DIR/.env" 2>/dev/null | tail -n1; }
# Oudere versie? Nieuwer(a, b) is waar als a hoger is dan b.
is_newer() { [[ "$1" != "$2" && "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -n1)" == "$1" ]]; }
# Eén regel uit een JSON-bestand van update.sh (alleen vaste velden, geen geheimen).
json_field() { grep -oE "\"$2\":\"[^\"]*\"" "$1" 2>/dev/null | head -n1 | cut -d'"' -f4 || true; }
# Voert psql uit in de databasecontainer (alleen lezen, geen wachtwoord nodig: lokale socket).
psql_value() { docker exec -u postgres aquatech-postgres psql -X -A -t -d aquatech -c "$1" 2>/dev/null | head -n1 | tr -d '[:space:]'; }

# Versie in de database (schema_version) of leeg als er geen eigen PostgreSQL draait.
db_version() { psql_value 'SELECT version FROM aquatech.schema_version'; }
# Versie die de draaiende app verwacht (basisversie + aantal PostgreSQL-migraties in de image).
expected_version() {
  docker exec aquatech node -e "const s=require('./src/database/pgschema');console.log(s.PG_BASE_VERSION+s.PG_MIGRATIONS.length)" 2>/dev/null | head -n1 | tr -d '[:space:]'
}
# Versie die de draaiende app meldt op /api/health (leeg bij geen antwoord).
health_version() {
  curl -fsS -m 10 http://localhost:3300/api/health 2>/dev/null | grep -oE '"version":"[^"]*"' | head -n1 | cut -d'"' -f4 || true
}
# Wacht tot de container healthy is (hoogstens ca. 2 minuten).
wait_healthy() {
  local state=""
  for _ in $(seq 1 40); do
    state="$(docker inspect -f '{{.State.Health.Status}}' aquatech 2>/dev/null || true)"
    [[ "$state" == "healthy" ]] && return 0
    sleep 3
  done
  return 1
}

# ---------- status ----------
remote_status() {
  local log_since="${LOG_SINCE:-24h}"
  section "Containers"
  local name state health restarts
  for name in aquatech aquatech-postgres aquatech-cloudflared; do
    if ! docker inspect "$name" >/dev/null 2>&1; then
      if [[ "$name" == aquatech-postgres ]]; then warn "$name bestaat niet (database in Supabase?)"; else fail "$name bestaat niet"; fi
      continue
    fi
    state="$(docker inspect -f '{{.State.Status}}' "$name")"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$name")"
    restarts="$(docker inspect -f '{{.RestartCount}}' "$name")"
    if [[ "$state" != running ]]; then fail "$name draait niet (status: $state)"
    elif [[ "$health" != healthy && "$health" != "-" ]]; then fail "$name is $health"
    elif (( restarts > 0 )); then warn "$name draait, maar is $restarts keer herstart"
    else ok "$name draait${health:+ ($health)}"; fi
  done

  section "App"
  local health_ms version tag
  version="$(health_version)"
  if [[ -n "$version" ]]; then
    health_ms="$(curl -s -o /dev/null -m 10 -w '%{time_total}' http://localhost:3300/api/health 2>/dev/null || echo 0)"
    ok "/api/health antwoordt (versie $version, ${health_ms}s)"
  else
    fail "/api/health antwoordt niet"
  fi
  tag="$(env_get AQUATECH_TAG)"
  [[ -n "$tag" && -n "$version" && "$tag" != "$version" ]] && warn "versie in .env ($tag) wijkt af van wat draait ($version)"
  local status_file="$APP_DIR/update/status/status.json" run_file="$APP_DIR/update/status/run.json" available
  if [[ -f "$status_file" ]]; then
    available="$(json_field "$status_file" available)"
    if [[ "$available" =~ $VERSION_RE && -n "$version" ]] && is_newer "$available" "$version"; then
      warn "nieuwere versie beschikbaar: $available (draait $version); de timer rolt hem uit, of draai: servertaken.sh update"
    else
      ok "geen nieuwere versie bekend (laatst gecontroleerd: $(json_field "$status_file" checkedAt))"
    fi
  else
    warn "geen update-status gevonden (update/status/status.json)"
  fi
  if [[ -f "$run_file" ]]; then
    case "$(json_field "$run_file" state)" in
      geslaagd) ok "laatste uitrol geslaagd ($(json_field "$run_file" version), $(json_field "$run_file" finishedAt))" ;;
      bezig) warn "er loopt een uitrol: $(json_field "$run_file" step)" ;;
      "") ;;
      *) fail "laatste uitrol: $(json_field "$run_file" state) - $(json_field "$run_file" message)" ;;
    esac
  fi
  [[ -f "$APP_DIR/.failed-version" ]] && warn "versie $(cat "$APP_DIR/.failed-version") faalde eerder en wordt door de timer overgeslagen"
  if systemctl is-active --quiet aquatech-update.timer 2>/dev/null; then ok "update-timer actief"; else fail "aquatech-update.timer is niet actief"; fi
  [[ -f "$APP_DIR/update/status/maintenance.json" ]] && warn "onderhoudsmodus staat aan (schrijven wordt geweigerd)"

  section "Database"
  if docker inspect aquatech-postgres >/dev/null 2>&1; then
    if docker exec aquatech-postgres pg_isready -U postgres -d aquatech >/dev/null 2>&1; then ok "PostgreSQL accepteert verbindingen"; else fail "PostgreSQL accepteert geen verbindingen"; fi
    local current expected
    current="$(db_version || true)"; expected="$(expected_version || true)"
    if ! [[ "$current" =~ ^[0-9]+$ && "$expected" =~ ^[0-9]+$ ]]; then warn "databaseversie niet te bepalen (database: '${current:-?}', app verwacht: '${expected:-?}')"
    elif [[ "$current" == "$expected" ]]; then ok "databaseversie $current is bij (app verwacht $expected)"
    elif (( current < expected )); then warn "database loopt achter: $current, app verwacht $expected (draai: servertaken.sh migraties)"
    else fail "database ($current) is nieuwer dan wat de app kent ($expected): een oudere versie draait op een nieuwere database"; fi
  else
    info "geen eigen PostgreSQL-container; databasecontrole overgeslagen"
  fi

  section "Server"
  local use_pct mem_available swap_used
  use_pct="$(df --output=pcent "$APP_DIR" 2>/dev/null | tail -n1 | tr -dc '0-9')"
  if [[ -z "$use_pct" ]]; then warn "schijfgebruik niet te bepalen"
  elif (( use_pct >= 95 )); then fail "schijf ${use_pct}% vol"
  elif (( use_pct >= 85 )); then warn "schijf ${use_pct}% vol"
  else ok "schijf ${use_pct}% vol"; fi
  mem_available="$(free -m | awk '/^Mem:/{print $7}')"
  swap_used="$(free -m | awk '/^Swap:/{print $3}')"
  if (( mem_available < 300 )); then fail "weinig geheugen vrij: ${mem_available} MB beschikbaar"
  elif (( mem_available < 800 )); then warn "geheugen krap: ${mem_available} MB beschikbaar"
  else ok "geheugen: ${mem_available} MB beschikbaar"; fi
  (( ${swap_used:-0} > 512 )) && warn "swap in gebruik: ${swap_used} MB"
  info "belasting: $(cut -d' ' -f1-3 /proc/loadavg), $(nproc) CPU's"

  section "Back-ups"
  local newest age_hours
  newest="$(find "$APP_DIR/backups/postgres" -maxdepth 1 -name 'aquatech-*.dump.enc' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -n1 || true)"
  if [[ -n "$newest" ]]; then
    age_hours=$(( ($(date +%s) - ${newest%%.*}) / 3600 ))
    if (( age_hours > 30 )); then fail "laatste databaseback-up is ${age_hours} uur oud (${newest#* })"; else ok "laatste databaseback-up ${age_hours} uur oud (${newest#* })"; fi
  elif docker inspect aquatech-postgres >/dev/null 2>&1; then
    fail "geen databaseback-ups gevonden in backups/postgres"
  fi
  if docker inspect aquatech-postgres >/dev/null 2>&1; then
    if systemctl is-active --quiet aquatech-pg-backup.timer 2>/dev/null; then ok "back-uptimer actief"; else fail "aquatech-pg-backup.timer is niet actief"; fi
  fi
  newest="$(find "$APP_DIR/data/backups" -maxdepth 1 -name 'aquatech-*.db.enc' -printf '%T@ %f\n' 2>/dev/null | sort -n | tail -n1 || true)"
  if [[ -n "$newest" ]]; then
    age_hours=$(( ($(date +%s) - ${newest%%.*}) / 3600 ))
    if (( age_hours > 48 )); then warn "laatste app-back-up is ${age_hours} uur oud (${newest#* })"; else ok "laatste app-back-up ${age_hours} uur oud (${newest#* })"; fi
  else
    warn "geen app-back-ups in data/backups"
  fi

  section "Trage verzoeken en stilstand (app-log, laatste $log_since)"
  local slow_lines slow_count stall_count
  slow_lines="$(docker logs --since "$log_since" aquatech 2>&1 | grep -E '^\[(traag|stilstand)\]|\[(traag|stilstand)\] ' || true)"
  slow_count="$(grep -c '\[traag\]' <<<"$slow_lines" || true)"
  stall_count="$(grep -c '\[stilstand\]' <<<"$slow_lines" || true)"
  if (( stall_count > 0 )); then warn "$stall_count keer stilstand van de server, $slow_count trage verzoeken/taken"
  elif (( slow_count > 20 )); then warn "$slow_count trage verzoeken/taken, geen stilstand"
  else ok "$slow_count trage verzoeken/taken, $stall_count keer stilstand"; fi
  if [[ -n "$slow_lines" ]]; then
    info "laatste regels (alle: servertaken.sh logs):"
    tail -n 5 <<<"$slow_lines" | cut -c1-220 | sed 's/^/         /'
  fi

  section "Samenvatting"
  printf '  %d in orde, %d waarschuwing(en), %d fout(en)\n' "$OK_COUNT" "$WARN_COUNT" "$FAIL_COUNT"
  if (( FAIL_COUNT > 0 )); then echo "  Stand: AANDACHT NODIG"; return 1
  elif (( WARN_COUNT > 0 )); then echo "  Stand: werkt, met opmerkingen"
  else echo "  Stand: alles in orde"; fi
}

# ---------- logs ----------
remote_logs() {
  local hours="${1:-24}"
  [[ "$hours" =~ ^[0-9]{1,4}$ ]] || { echo "FOUT: geef het aantal uren als getal (bijv. logs 48)." >&2; return 2; }
  docker logs --since "${hours}h" aquatech 2>&1 | grep -E '\[(traag|stilstand)\]' | cut -c1-400 || echo "Geen [traag]- of [stilstand]-regels in de laatste ${hours} uur."
}

# ---------- migraties ----------
# Alleen lezen. Uitgangscode 10 = de database loopt achter en een herstart migreert; 0 = niets te doen.
remote_migrate_check() {
  docker inspect aquatech-postgres >/dev/null 2>&1 || { echo "Geen eigen PostgreSQL-container: migraties draaien bij het starten van de app (niets te doen)."; return 0; }
  local current expected
  current="$(db_version || true)"; expected="$(expected_version || true)"
  [[ "$current" =~ ^[0-9]+$ && "$expected" =~ ^[0-9]+$ ]] || { echo "FOUT: databaseversie ('${current:-?}') of verwachte versie ('${expected:-?}') niet te bepalen." >&2; return 1; }
  echo "Databaseversie: $current; de draaiende app verwacht: $expected."
  if [[ "$current" == "$expected" ]]; then echo "De database is bij: er zijn geen migraties te draaien."; return 0; fi
  if (( current > expected )); then echo "FOUT: de database is nieuwer dan de app; migreren is hier niet het probleem (draait er een oudere versie?)." >&2; return 1; fi
  echo "De database loopt $((expected - current)) migratie(s) achter. De app migreert zelf bij het starten; een herstart voert ze uit."
  return 10
}
# Back-up, herstart de app (de app migreert bij het starten), wacht tot hij healthy is en controleert de versie.
remote_migrate_run() {
  cd "$APP_DIR"
  log "Back-up maken"
  docker compose exec -T -u 1000 aquatech node src/backup.js create || { echo "FOUT: back-up mislukt; niet herstart." >&2; return 1; }
  log "App herstarten (migraties draaien bij het starten)"
  docker compose restart aquatech
  wait_healthy || { echo "FOUT: de app is na de herstart niet healthy. Bekijk: docker compose logs --tail 80 aquatech" >&2; return 1; }
  local current expected
  current="$(db_version || true)"; expected="$(expected_version || true)"
  echo "Databaseversie nu: ${current:-?}; app verwacht: ${expected:-?}."
  [[ -n "$current" && "$current" == "$expected" ]] || { echo "FOUT: de database is niet bijgewerkt. Bekijk: docker compose logs --tail 80 aquatech" >&2; return 1; }
  echo "Klaar: de database is bij."
}

# ---------- update ----------
# Alleen lezen. Uitgangscode 10 = er staat een nieuwere versie klaar; 0 = niets te doen.
remote_update_check() {
  local running available
  running="$(health_version)"; [[ -n "$running" ]] || running="$(env_get AQUATECH_TAG)"
  docker pull -q "$IMAGE:latest" >/dev/null || { echo "FOUT: ophalen van $IMAGE:latest mislukt." >&2; return 1; }
  available="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE:latest")"
  [[ "$available" =~ $VERSION_RE ]] || { echo "FOUT: geen geldig versielabel op $IMAGE:latest." >&2; return 1; }
  echo "Draait: ${running:-onbekend}; beschikbaar in GHCR: $available."
  if [[ -n "$running" ]] && ! is_newer "$available" "$running"; then echo "Er is geen nieuwere versie: niets te doen."; return 0; fi
  if [[ -f "$APP_DIR/.failed-version" && "$(cat "$APP_DIR/.failed-version")" == "$available" ]]; then
    echo "Let op: versie $available faalde eerder op deze server (.failed-version)."
  fi
  return 10
}
# Start de updateservice (zelfde pad als de timer); staat automatisch bijwerken uit, dan een aanvraag zoals de app die doet.
remote_update_run() {
  if ! systemctl cat aquatech-update.service >/dev/null 2>&1; then
    echo "FOUT: aquatech-update.service ontbreekt (zie setup-app-update.sh)." >&2; return 1
  fi
  local before available
  before="$(env_get AQUATECH_TAG)"
  log "Updateservice starten (back-up, onderhoudsmodus, wisselen, healthcheck, terugval)"
  systemctl start aquatech-update.service || true
  if [[ "$(env_get AQUATECH_TAG)" == "$before" ]]; then
    available="$(json_field "$APP_DIR/update/status/status.json" available)"
    if [[ "$available" =~ $VERSION_RE ]] && is_newer "$available" "$before" && [[ "$(cat "$APP_DIR/.failed-version" 2>/dev/null || true)" != "$available" ]]; then
      if [[ ! -d "$APP_DIR/update/request" ]]; then
        echo "FOUT: $APP_DIR/update/request bestaat niet; draai eerst setup-app-update.sh (dan krijgt de map de juiste eigenaar)." >&2; return 1
      fi
      log "Automatisch bijwerken staat uit of wacht: aanvraag voor $available klaarzetten"
      # Veilig schrijven: het tijdelijke bestand staat in de root-eigen statusmap (de app kan daar niets neerzetten) en
      # gaat met een rename naar de aanvraagmap; een symlink request.json van de app wordt zo vervangen, nooit gevolgd.
      local request_tmp
      request_tmp="$(mktemp "$APP_DIR/update/status/.tmp.XXXXXX")"
      printf '{"id":"%s","version":"%s","requestedAt":"%s","by":"servertaken","byName":"servertaken.sh"}\n' \
        "$(cat /proc/sys/kernel/random/uuid)" "$available" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$request_tmp"
      chown --reference="$APP_DIR/update/request" -- "$request_tmp"
      chmod 644 -- "$request_tmp"
      mv -T -f -- "$request_tmp" "$APP_DIR/update/request/request.json"
      systemctl start aquatech-update.service || true
    fi
  fi
  local run_file="$APP_DIR/update/status/run.json" state version
  state="$(json_field "$run_file" state)"
  echo "Uitrol: ${state:-onbekend} - $(json_field "$run_file" message)"
  version="$(health_version)"
  echo "Draait nu: ${version:-geen antwoord op /api/health}."
  [[ "$state" == "geslaagd" && -n "$version" && "$version" != "$before" ]] || { echo "De update is niet gelukt of er was niets te installeren; zie: servertaken.sh status" >&2; return 1; }
  echo "Klaar: versie $version draait."
}

# ---------- schijf ----------
# Versies van het app-image die blijven staan: de draaiende en de twee nieuwste. Gedeeld door check en run.
disk_keep_tags() {
  { env_get AQUATECH_TAG; docker image ls --format '{{.Tag}}' "$IMAGE" 2>/dev/null | grep -E "$VERSION_RE" | sort -rV | head -n 2; } | grep -E "$VERSION_RE" | sort -u || true
}
# Versies van het app-image die niet in de bewaarlijst staan (dus op te ruimen).
disk_old_tags() {
  local keep tag
  keep="$(disk_keep_tags)"
  for tag in $(docker image ls --format '{{.Tag}}' "$IMAGE" 2>/dev/null | grep -E "$VERSION_RE" || true); do
    grep -qx "$tag" <<<"$keep" || echo "$tag"
  done
}
# Alleen lezen: waar de schijf aan opgaat. Uitgangscode 10 = er is iets op te ruimen; 0 = niets te doen.
remote_disk_check() {
  section "Schijf"
  df -h / "$APP_DIR" 2>/dev/null | awk 'NR==1 || !seen[$0]++'
  section "Docker (images, containers, volumes, build-cache)"
  docker system df 2>/dev/null || true
  section "Aquatech-images (oude versies zijn op te ruimen)"
  docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' "$IMAGE" 2>/dev/null || true
  section "Grootste mappen in $APP_DIR"
  du -xsh "$APP_DIR"/* "$APP_DIR"/.[!.]* 2>/dev/null | sort -rh | head -n 8 || true
  section "Overig"
  info "journal: $(journalctl --disk-usage 2>/dev/null | grep -oE '[0-9.]+[KMG]' | head -n1 || echo onbekend)"
  info "apt-cache: $(du -sh /var/cache/apt 2>/dev/null | cut -f1 || echo onbekend)"
  info "/var/lib/docker: $(du -xsh /var/lib/docker 2>/dev/null | cut -f1 || echo onbekend)"
  local reclaimable old_count
  reclaimable="$(docker image ls -q --filter dangling=true 2>/dev/null | wc -l)"
  old_count="$(disk_old_tags | wc -l)"
  echo
  echo "Op te ruimen: $old_count oude versie(s) van het app-image (de draaiende en de twee nieuwste blijven), $reclaimable ongebruikte image(s), build-cache, oude journal."
  (( old_count > 0 || reclaimable > 0 )) && return 10
  return 0
}
# Haalt update.sh uit GitHub op een vaste commit (UPDATE_SH_REF, 40 tekens; zonder verwijzing gebeurt er niets) en installeert hem in APP_DIR als hij
# afwijkt. Eerst controleren (syntaxis, verwachte inhoud), de oude blijft als update.sh.bak-<datum>. Mislukt het, dan blijft de
# huidige update.sh staan en gaat het opruimen gewoon door.
refresh_update_script() {
  local ref="${UPDATE_SH_REF:-}" base="${UPDATE_SH_BASE:-https://raw.githubusercontent.com/danieldh00/Aquatech}" tmp
  # Alleen een vaste commit (geen master): een root-script op de server mag niet meeveranderen met een branch.
  [[ -n "$ref" ]] || { echo "  update.sh niet bijgewerkt: geef UPDATE_SH_REF=<commit van 40 tekens> mee"; return 0; }
  [[ "$ref" =~ ^[0-9a-f]{40}$ ]] || { echo "  update.sh niet bijgewerkt: ongeldige verwijzing '$ref' (een volledige commit is nodig)"; return 0; }
  tmp="$(mktemp)"
  if ! curl -fsSL -m 30 "$base/$ref/deploy/apps01/update.sh" -o "$tmp" 2>/dev/null; then echo "  update.sh niet bijgewerkt: ophalen mislukt"; rm -f "$tmp"; return 0; fi
  if ! bash -n "$tmp" 2>/dev/null || ! grep -q '^VERSION_RE=' "$tmp" || ! grep -q 'org.opencontainers.image.version' "$tmp"; then
    echo "  update.sh niet bijgewerkt: het opgehaalde bestand is niet zoals verwacht"; rm -f "$tmp"; return 0
  fi
  if cmp -s "$tmp" "$APP_DIR/update.sh"; then echo "  update.sh is al de nieuwste"; rm -f "$tmp"; return 0; fi
  # Niet midden in een lopende update het bestand vervangen.
  if [[ -f "$APP_DIR/update/status/maintenance.json" ]] || [[ "$(json_field "$APP_DIR/update/status/run.json" state)" == "bezig" ]]; then
    echo "  update.sh niet bijgewerkt: er loopt een update (probeer het straks opnieuw)"; rm -f "$tmp"; return 0
  fi
  if [[ -f "$APP_DIR/update.sh" ]] && ! cp "$APP_DIR/update.sh" "$APP_DIR/update.sh.bak-$(date +%Y%m%d%H%M%S)" 2>/dev/null; then
    echo "  update.sh niet bijgewerkt: back-up van de huidige mislukt (schijf vol?)"; rm -f "$tmp"; return 0
  fi
  install -m 755 "$tmp" "$APP_DIR/update.sh" || { echo "  update.sh niet bijgewerkt: installeren mislukt"; rm -f "$tmp"; return 0; }
  echo "  update.sh bijgewerkt (oude als update.sh.bak-<datum> bewaard)"
  # Alleen de laatste drie back-ups van update.sh bewaren.
  { ls -1 "$APP_DIR"/update.sh.bak-* 2>/dev/null || true; } | sort | head -n -3 | xargs -r rm -f --
  rm -f "$tmp"
}
# Ruimt veilig op: oude app-images (de draaiende versie en de twee nieuwste blijven), ongebruikte images, build-cache,
# journal tot 200 MB en de apt-cache, en werkt update.sh op de server bij (zodat uitrollen voortaan zelf opruimen). Raakt geen volumes, geen back-ups en geen database.
remote_disk_run() {
  local before after tag
  refresh_update_script
  before="$(df --output=avail -B1M / | tail -n1 | tr -d ' ')"
  for tag in $(disk_old_tags); do
    docker rmi "$IMAGE:$tag" >/dev/null 2>&1 && echo "  verwijderd: $IMAGE:$tag" || echo "  blijft staan (in gebruik): $IMAGE:$tag"
  done
  docker image prune -f >/dev/null || true
  docker builder prune -f >/dev/null 2>&1 || true
  journalctl --vacuum-size=200M >/dev/null 2>&1 || true
  apt-get clean >/dev/null 2>&1 || true
  after="$(df --output=avail -B1M / | tail -n1 | tr -d ' ')"
  echo "Vrije ruimte: ${before} MB -> ${after} MB (winst $((after - before)) MB)."
  df -h / | tail -n1
}

# ---------- servertaken (openstaand) ----------
# Alle taken, oudste eerst. Zelfde id's als HOST_TASKS in hub/backend/src/platform/host-tasks.js (een test bewaakt dat).
HOST_TASK_IDS=(
  001-app-update-opnieuw-inrichten
  002-hersteltest-back-up-inrichten
  003-hersteltest-script-bijwerken
  004-pg-back-up-script-herstellen
  005-hersteltest-app-controle
  006-database-grootte-en-indexgebruik
  007-hersteltest-drive-app-controle
  008-vertrouwde-proxy-instellen
  009-update-script-stopt-bij-mislukte-back-up
)
HOST_TASKS_LEDGER="host-tasks.json"
# Functienaam van een taak (streepjes worden underscores).
hosttask_function() { printf 'hosttask_%s' "${1//-/_}"; }
# Id's die al gedaan zijn (uit update/status/host-tasks.json; alleen id's in het vaste formaat).
ledger_done_ids() {
  grep -oE '"[0-9]{3}-[a-z0-9-]{1,80}":"[^"]*"' "$APP_DIR/update/status/$HOST_TASKS_LEDGER" 2>/dev/null | cut -d'"' -f2 || true
}
# Schrijft het logboek opnieuw met de gedane id's (+ eventueel één nieuwe) in één keer (tijdelijk bestand + mv, zoals update.sh).
ledger_write() { # [nieuwe id]
  local status_dir="$APP_DIR/update/status" now_text entries="" id tmp
  mkdir -p "$status_dir"
  now_text="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  for id in $(ledger_done_ids); do
    if [[ "$id" != "${1:-}" ]]; then entries+="${entries:+,}\"$id\":\"$(ledger_time "$id")\""; fi
  done
  if [[ -n "${1:-}" ]]; then entries+="${entries:+,}\"$1\":\"$now_text\""; fi
  tmp="$(mktemp "$status_dir/.tmp.XXXXXX")"
  printf '{"done":{%s},"checkedAt":"%s"}\n' "$entries" "$now_text" > "$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$status_dir/$HOST_TASKS_LEDGER"
}
# Tijdstip waarop een id als gedaan is vastgelegd (leeg tijdstip → nu).
ledger_time() {
  local at
  at="$(grep -oE "\"$1\":\"[^\"]*\"" "$APP_DIR/update/status/$HOST_TASKS_LEDGER" 2>/dev/null | head -n1 | cut -d'"' -f4 || true)"
  printf '%s' "${at:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
}
# Taken die nog niet gedaan zijn, één id per regel.
pending_host_tasks() {
  local done_ids id
  done_ids="$(ledger_done_ids)"
  for id in "${HOST_TASK_IDS[@]}"; do
    grep -qx -- "$id" <<<"$done_ids" || echo "$id"
  done
}
# De commit waarop de taken draaien (TASKS_REF, 40 tekens): een root-script op de server loopt nooit mee met een branch.
need_tasks_ref() {
  [[ "${TASKS_REF:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "FOUT: geef TASKS_REF=<volledige commit van 40 tekens> mee (het vaste commando uit de app doet dat zelf)." >&2; exit 2; }
}
# Haalt een bestand uit de repo op TASKS_REF en controleert de syntaxis (pad in $2, doel in $1).
fetch_task_file() { # <doel> <pad in de repo>
  local base="${TASKS_BASE:-https://raw.githubusercontent.com/danieldh00/Aquatech}"
  curl -fsSL -m 60 "$base/$TASKS_REF/$2" -o "$1" || { echo "FOUT: ophalen van $2 mislukt." >&2; return 1; }
  bash -n "$1" || { echo "FOUT: $2 is geen geldig script." >&2; return 1; }
}

# Taak 001: setup-app-update.sh opnieuw draaien (update.sh, compose.yml en units vernieuwen, container opnieuw). Veilig herhaalbaar.
hosttask_001_app_update_opnieuw_inrichten() {
  local dir rc=0
  dir="$(mktemp -d)"
  fetch_task_file "$dir/setup-app-update.sh" deploy/apps01/setup-app-update.sh || { rm -rf "$dir"; return 1; }
  SETUP_REF="$TASKS_REF" APP_DIR="$APP_DIR" bash "$dir/setup-app-update.sh" || rc=$?
  rm -rf "$dir"
  return "$rc"
}

# Taak 009: update.sh vernieuwen (stopt bij een mislukte back-up vooraf); zelfde handeling als taak 001. Veilig herhaalbaar.
hosttask_009_update_script_stopt_bij_mislukte_back_up() {
  hosttask_001_app_update_opnieuw_inrichten
}

# Taak 002: de wekelijkse hersteltest van de back-up inrichten (restore-test.sh + timer + path-unit). Veilig herhaalbaar.
hosttask_002_hersteltest_back_up_inrichten() {
  local dir file
  dir="$(mktemp -d)"
  for file in restore-test.sh restore-app-check.sh restore-test-drive.sh; do
    fetch_task_file "$dir/$file" "deploy/apps01/$file" || { rm -rf "$dir"; return 1; }
  done
  for file in aquatech-restore-test.service aquatech-restore-test.timer aquatech-restore-test.path aquatech-restore-test-drive.service aquatech-restore-test-drive.path; do
    curl -fsSL -m 60 "${TASKS_BASE:-https://raw.githubusercontent.com/danieldh00/Aquatech}/$TASKS_REF/deploy/apps01/systemd/$file" -o "$dir/$file" \
      || { echo "FOUT: ophalen van $file mislukt." >&2; rm -rf "$dir"; return 1; }
  done
  [[ -d "$APP_DIR/update/request" ]] || { echo "FOUT: update/request ontbreekt; draai eerst taak 001." >&2; rm -rf "$dir"; return 1; }
  for file in restore-test.sh restore-app-check.sh restore-test-drive.sh; do
    install -m 755 "$dir/$file" "$APP_DIR/$file"
  done
  for file in aquatech-restore-test.service aquatech-restore-test.timer aquatech-restore-test.path aquatech-restore-test-drive.service aquatech-restore-test-drive.path; do
    install -m 644 "$dir/$file" "${SYSTEMD_DIR:-/etc/systemd/system}/$file"
  done
  rm -rf "$dir"
  systemctl daemon-reload
  systemctl enable --now aquatech-restore-test.timer aquatech-restore-test.path aquatech-restore-test-drive.path >/dev/null
  echo "Hersteltest ingericht: timer $(systemctl is-active aquatech-restore-test.timer), path $(systemctl is-active aquatech-restore-test.path), Drive-controle $(systemctl is-active aquatech-restore-test-drive.path)."
}

# Taak 003: het hostscript restore-test.sh vernieuwen (een app-update raakt dat niet). Zelfde inrichting als taak 002, veilig herhaalbaar.
hosttask_003_hersteltest_script_bijwerken() {
  hosttask_002_hersteltest_back_up_inrichten
}

# Taak 004: pg-backup.sh en restore-test.sh vernieuwen en direct een back-up maken (de oude controle keurde elke grotere back-up af).
hosttask_004_pg_back_up_script_herstellen() {
  local dir
  dir="$(mktemp -d)"
  fetch_task_file "$dir/pg-backup.sh" deploy/apps01/localdb/pg-backup.sh || { rm -rf "$dir"; return 1; }
  [[ -d "$APP_DIR/backups" ]] || mkdir -p "$APP_DIR/backups"
  install -m 755 "$dir/pg-backup.sh" "$APP_DIR/pg-backup.sh"
  rm -rf "$dir"
  hosttask_002_hersteltest_back_up_inrichten || return 1
  (cd "$APP_DIR" && bash ./pg-backup.sh) || { echo "FOUT: de back-up mislukte; zie bovenstaande melding." >&2; return 1; }
  echo "pg-backup.sh vernieuwd en een back-up gemaakt."
}

# Taak 005: restore-test.sh vernieuwen (de hersteltest start nu ook een wegwerp-app op de teruggezette database).
hosttask_005_hersteltest_app_controle() {
  hosttask_002_hersteltest_back_up_inrichten
}

# Taak 007: de app-controle van de Drive-hersteltest inrichten (restore-test-drive.sh + restore-app-check.sh + path-unit); vernieuwt ook de lokale hersteltest.
hosttask_007_hersteltest_drive_app_controle() {
  hosttask_002_hersteltest_back_up_inrichten
}

# Taak 008: TRUSTED_PROXIES in .env zetten (het IPv4-subnet(ten) van de netwerken van de app, waar cloudflared in zit) en
# compose.yml vernieuwen (taak 001), zodat de app proxykoppen alleen van dat netwerk gelooft. Veilig herhaalbaar.
hosttask_008_vertrouwde_proxy_instellen() {
  local networks subnets env_file="$APP_DIR/.env" tmp
  # Alle netwerken van de app (cloudflared zit in hetzelfde compose-project, dus in een van deze subnetten).
  networks="$(docker inspect aquatech --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null)"
  [[ -n "${networks// /}" ]] || { echo "FOUT: de container aquatech draait niet; geen netwerk gevonden." >&2; return 1; }
  # shellcheck disable=SC2086
  subnets="$(docker network inspect $networks --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' | paste -sd, -)"
  [[ -n "$subnets" ]] || { echo "FOUT: geen IPv4-subnet van de netwerken $networks gevonden." >&2; return 1; }
  touch "$env_file"
  tmp="$(mktemp "$APP_DIR/.env.XXXXXX")"
  { grep -v '^TRUSTED_PROXIES=' "$env_file" || true; echo "TRUSTED_PROXIES=$subnets"; } > "$tmp"
  chmod --reference="$env_file" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv -f "$tmp" "$env_file"
  echo "TRUSTED_PROXIES=$subnets gezet in $env_file."
  hosttask_001_app_update_opnieuw_inrichten
}

# Taak 006: alleen lezen. Toont de grootste tabellen en het gebruik van de indexen van de productiedatabase (voor de beslissing over
# zware kolomomzettingen) en bewaart dezelfde uitvoer in update/status/db-stats.txt. Geen gegevens, alleen namen, aantallen en groottes.
hosttask_006_database_grootte_en_indexgebruik() {
  local out="$APP_DIR/update/status/db-stats.txt" tmp
  docker inspect aquatech-postgres >/dev/null 2>&1 || { echo "FOUT: geen eigen PostgreSQL-container (aquatech-postgres)." >&2; return 1; }
  mkdir -p "$APP_DIR/update/status"
  tmp="$(mktemp "$APP_DIR/update/status/.tmp.XXXXXX")"
  {
    echo "== Database-statistieken $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
    echo "-- Grootste tabellen (met indexen), aantal rijen volgens de statistieken --"
    docker exec -e PGOPTIONS='-c default_transaction_read_only=on' -u postgres aquatech-postgres psql -X -A -F ' | ' -t -d aquatech -c \
      "SELECT relname, pg_size_pretty(pg_total_relation_size(relid)), n_live_tup FROM pg_stat_user_tables WHERE schemaname = 'aquatech' ORDER BY pg_total_relation_size(relid) DESC LIMIT 25" || return 1
    echo "-- Indexen die sinds de laatste statistiekreset nooit gebruikt zijn (groter dan 1 MB, niet uniek) --"
    docker exec -e PGOPTIONS='-c default_transaction_read_only=on' -u postgres aquatech-postgres psql -X -A -F ' | ' -t -d aquatech -c \
      "SELECT s.relname, s.indexrelname, pg_size_pretty(pg_relation_size(s.indexrelid)), s.idx_scan FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid WHERE s.schemaname = 'aquatech' AND s.idx_scan = 0 AND NOT i.indisunique AND pg_relation_size(s.indexrelid) > 1048576 ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 25" || return 1
    echo "-- Statistieken lopen sinds --"
    docker exec -e PGOPTIONS='-c default_transaction_read_only=on' -u postgres aquatech-postgres psql -X -A -t -d aquatech -c "SELECT COALESCE(stats_reset::text, 'nooit gereset') FROM pg_stat_database WHERE datname = 'aquatech'" || return 1
  } > "$tmp" || { rm -f "$tmp"; echo "FOUT: de database-statistieken ophalen mislukte." >&2; return 1; }
  chmod 644 "$tmp"
  mv -f "$tmp" "$out"
  cat "$out"
  echo "Bewaard in $out."
}

# Toont wat er openstaat. Uitgangscode 10 = er is iets te doen (two_step vraagt dan om bevestiging).
remote_openstaand_check() {
  local pending
  need_tasks_ref
  pending="$(pending_host_tasks)"
  if [[ -z "$pending" ]]; then
    ledger_write
    echo "Alle servertaken zijn gedaan. Niets te doen."
    return 0
  fi
  echo "Openstaande servertaken (uit commit ${TASKS_REF:0:10}):"
  for id in $pending; do echo "  - $id"; done
  return 10
}
# Voert de openstaande taken één voor één uit en legt elke gelukte taak vast. Bij een fout stopt het (de rest blijft open).
remote_openstaand_run() {
  local id
  need_tasks_ref
  for id in $(pending_host_tasks); do
    echo; echo "== Taak $id =="
    if "$(hosttask_function "$id")"; then
      ledger_write "$id"
      echo "Taak $id gedaan en vastgelegd."
    else
      echo "FOUT: taak $id is mislukt; de overige taken zijn niet uitgevoerd. Draai het commando opnieuw als het probleem opgelost is." >&2
      return 1
    fi
  done
  echo; echo "Alle servertaken zijn gedaan."
}

remote_main() {
  exec </dev/null
  cd "$APP_DIR" 2>/dev/null || { echo "FOUT: $APP_DIR bestaat niet op de server (zet APP_DIR)." >&2; exit 1; }
  command -v docker >/dev/null || { echo "FOUT: docker niet gevonden op de server." >&2; exit 1; }
  local action="${1:-status}"; shift || true
  case "$action" in
    status) remote_status ;;
    logs) remote_logs "$@" ;;
    migraties-check) remote_migrate_check ;;
    migraties-run) remote_migrate_run ;;
    update-check) remote_update_check ;;
    update-run) remote_update_run ;;
    schijf-check) remote_disk_check ;;
    schijf-run) remote_disk_run ;;
    openstaand-check) remote_openstaand_check ;;
    openstaand-run) remote_openstaand_run ;;
    *) echo "Onbekende opdracht: $action" >&2; exit 2 ;;
  esac
}

if [[ "${SERVERTAKEN_REMOTE:-}" == "1" ]]; then
  remote_main "$@"
  exit $?
fi

# =====================================================================================================================
# Deel 2: draait OP DE PROXMOX-HOST. Zoekt apps01 en voert dit bestand daar uit.
# =====================================================================================================================
NAME="${APPS01_NAME:-apps01}"
die() { echo "FOUT: $*" >&2; exit 1; }
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ARGS=()
for argument in "$@"; do
  case "$argument" in
    -y | --yes) YES=1 ;;
    -h | --help) usage ;;
    *) ARGS+=("$argument") ;;
  esac
done
ACTION="${ARGS[0]:-status}"
case "$ACTION" in
  status | logs | migraties | update | schijf | openstaand) ;;
  help) usage ;;
  *) usage ;;
esac
[[ $(id -u) -eq 0 ]] || die "Draai dit als root op de Proxmox-host."

# ---------- Gast-systeem zoeken: LXC (pct exec) of VM/host (ssh) ----------
MODE=""; GUEST_ID=""; SSH_TARGET="${APPS01_SSH:-}"
find_guest() {
  if [[ -n "$SSH_TARGET" ]]; then MODE="ssh"; return; fi
  if [[ -n "${APPS01_CTID:-}" ]]; then MODE="pct"; GUEST_ID="$APPS01_CTID"; return; fi
  if [[ -n "${APPS01_VMID:-}" ]]; then MODE="vm"; GUEST_ID="$APPS01_VMID"; return; fi
  local id
  if command -v pct >/dev/null && id="$(pct list 2>/dev/null | awk -v n="$NAME" 'NR>1 && $NF==n {print $1; exit}')" && [[ -n "$id" ]]; then
    MODE="pct"; GUEST_ID="$id"; return
  fi
  if command -v qm >/dev/null && id="$(qm list 2>/dev/null | awk -v n="$NAME" 'NR>1 && $2==n {print $1; exit}')" && [[ -n "$id" ]]; then
    MODE="vm"; GUEST_ID="$id"; return
  fi
  MODE="ssh"; SSH_TARGET="root@$NAME"   # niet gevonden in Proxmox: dan als gewone host via ssh
}
find_guest

if [[ "$MODE" == "vm" ]]; then
  if [[ -z "$SSH_TARGET" ]]; then
    if getent hosts "$NAME" >/dev/null 2>&1; then
      SSH_TARGET="root@$NAME"
    else
      ip="$(qm guest cmd "$GUEST_ID" network-get-interfaces 2>/dev/null | python3 -c '
import json, sys
for nic in json.load(sys.stdin):
    for addr in nic.get("ip-addresses", []):
        ip = addr.get("ip-address", "")
        if addr.get("ip-address-type") == "ipv4" and not ip.startswith(("127.", "169.254.")):
            print(ip); sys.exit(0)
' || true)"
      [[ -n "$ip" ]] || die "VM $GUEST_ID ($NAME) is niet te bereiken: geen DNS-naam en geen IP via de guest agent. Zet APPS01_SSH=root@<ip>."
      SSH_TARGET="root@$ip"
    fi
  fi
  MODE="ssh"
fi

SSH_OPTS=(-o ServerAliveInterval=30 -o ServerAliveCountMax=20 -o ConnectTimeout=15)
# Als de ssh-gebruiker geen root is (bijv. APPS01_SSH=daniel@apps01), gaat elke opdracht via sudo zonder wachtwoord.
SUDO=()
if [[ "$MODE" == "ssh" && "$SSH_TARGET" == *@* && "${SSH_TARGET%%@*}" != "root" ]]; then SUDO=(sudo -n); fi
# Voert dit bestand op de server uit met een opdracht (het bestand gaat via stdin mee).
remote() { # <opdracht> [argumenten...]
  local environment=(SERVERTAKEN_REMOTE=1 "APP_DIR=$APP_DIR" "LOG_SINCE=${LOG_SINCE:-24h}")
  [[ -n "${UPDATE_SH_REF:-}" ]] && environment+=("UPDATE_SH_REF=$UPDATE_SH_REF")
  [[ -n "${TASKS_REF:-}" ]] && environment+=("TASKS_REF=$TASKS_REF")
  if [[ "$MODE" == "pct" ]]; then
    pct exec "$GUEST_ID" -- env "${environment[@]}" bash -s -- "$@" <"$0"
  else
    local command_line
    printf -v command_line '%q ' "${SUDO[@]}" env "${environment[@]}" bash -s -- "$@"
    # shellcheck disable=SC2029  # bewust: de opdracht wordt hier opgebouwd en op de server uitgevoerd
    ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$command_line" <"$0"
  fi
}

# Vraagt om bevestiging (met --yes/YES=1 niet). Zonder terminal en zonder --yes: afbreken.
confirm() { # <tekst>
  [[ "${YES:-}" == "1" ]] && return 0
  echo
  echo -e "$1"
  local answer
  printf "Typ 'ja' om door te gaan: " >&2
  { read -r answer </dev/tty; } 2>/dev/null || die "Geen terminal om te bevestigen; gebruik --yes."
  [[ "$answer" == "ja" ]] || { echo "Afgebroken; niets veranderd."; exit 0; }
}

if [[ "$MODE" == "pct" ]]; then echo "Server: LXC $GUEST_ID ($NAME), via pct exec"; else echo "Server: $SSH_TARGET, via ssh"; fi

# Voert check + (na bevestiging) uitvoering uit. Check-uitgangscode 10 = er is iets te doen.
two_step() { # <naam> <bevestigingstekst>
  local name="$1" question="$2" code=0
  remote "$name-check" || code=$?
  case "$code" in
    0) exit 0 ;;
    10) ;;
    *) exit "$code" ;;
  esac
  confirm "$question"
  remote "$name-run"
}

case "$ACTION" in
  status) remote status ;;
  logs) remote logs "${ARGS[@]:1}" ;;
  migraties) two_step migraties "De app wordt na een back-up herstart en is daarbij ca. 1 minuut niet beschikbaar; bij het starten draaien de migraties." ;;
  schijf) two_step schijf "Oude app-images, build-cache en oude journal worden verwijderd en update.sh op de server wordt bijgewerkt (de draaiende en de twee nieuwste versies blijven; volumes, back-ups en database blijven onaangeroerd). De app blijft gewoon draaien." ;;
  openstaand) two_step openstaand "De openstaande servertaken worden nu uitgevoerd (ze staan hierboven; de app kan daarbij even herstarten). Elke gelukte taak wordt afgevinkt in de app." ;;
  update) two_step update "De app wordt na een back-up vervangen door de nieuwste versie (ca. 1-3 minuten onderhoudsmodus). Lukt het niet, dan zet update.sh de vorige versie terug." ;;
esac
