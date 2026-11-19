#!/usr/bin/env bash
# Vaste servertaken voor Aquatech op apps01: bediening VANAF DE PROXMOX-HOST (pve), als root.
#
#   bash servertaken.sh                  status (standaard): alleen lezen, met samenvatting
#   bash servertaken.sh status           idem
#   bash servertaken.sh logs [uren]      alle [traag]- en [stilstand]-regels van de app (standaard 24 uur)
#   bash servertaken.sh migraties        controleert de databaseversie; loopt hij achter, dan de app herstarten (migreren)
#   bash servertaken.sh update           nu updaten naar de nieuwste versie in GHCR (met back-up en terugval)
#   bash servertaken.sh schijf           toont wat de schijf vult en ruimt na bevestiging op (oude app-images, build-cache, journal)
#   bash servertaken.sh help             deze uitleg
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
      if [[ "$name" == aquatech-postgres ]]; then warn "$name bestaat niet (database in Supabase of SQLite?)"; else fail "$name bestaat niet"; fi
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
# Ruimt veilig op: oude app-images (de draaiende versie en de twee nieuwste blijven), ongebruikte images, build-cache,
# journal tot 200 MB en de apt-cache. Raakt geen volumes, geen back-ups en geen database.
remote_disk_run() {
  local before after tag
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
usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

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
  status | logs | migraties | update | schijf) ;;
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
  schijf) two_step schijf "Oude app-images, build-cache en oude journal worden verwijderd (de draaiende en de twee nieuwste versies blijven; volumes, back-ups en database blijven onaangeroerd). De app blijft gewoon draaien." ;;
  update) two_step update "De app wordt na een back-up vervangen door de nieuwste versie (ca. 1-3 minuten onderhoudsmodus). Lukt het niet, dan zet update.sh de vorige versie terug." ;;
esac
