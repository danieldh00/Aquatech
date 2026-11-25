#!/usr/bin/env bash
# Verwijdert de stagingomgeving van apps01 volledig (servertaak 016): timer en units, de twee stagingcontainers, hun
# netwerk, de lokaal gebouwde stagingimages en de map /opt/apps/aquatech-staging (clone, .env, geheimen, database).
# Raakt de testomgeving niet: alleen exacte namen, en containers alleen als ze bij het compose-project aquatech-staging horen.
# Veilig herhaalbaar (niets meer te doen = klaar); draait als root; vraagt geen invoer.
set -euo pipefail

STAGING_DIR="${STAGING_DIR:-/opt/apps/aquatech-staging}"
SYSTEMD_DIR="${SYSTEMD_DIR:-/etc/systemd/system}"
PROJECT="aquatech-staging"
log() { echo "[$(date '+%F %T')] $*"; }

[[ $(id -u) -eq 0 ]] || exec sudo -E bash "$0" "$@"
command -v docker >/dev/null 2>&1 || { echo "FOUT: docker niet gevonden." >&2; exit 1; }

# 1. Timer en units
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now aquatech-staging-update.timer >/dev/null 2>&1 || true
  systemctl stop aquatech-staging-update.service >/dev/null 2>&1 || true
fi
for unit in aquatech-staging-update.timer aquatech-staging-update.service; do
  if [[ -e "$SYSTEMD_DIR/$unit" ]]; then rm -f "$SYSTEMD_DIR/$unit"; log "Unit $unit verwijderd."; fi
done
if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload >/dev/null 2>&1 || true; fi

# 2. Containers: alleen als ze bij het stagingproject horen
for container in aquatech-staging aquatech-staging-postgres; do
  project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container" 2>/dev/null || true)"
  [[ -z "$project" ]] && continue
  if [[ "$project" != "$PROJECT" ]]; then
    log "Container $container hoort niet bij project $PROJECT ($project); niet aangeraakt."
    continue
  fi
  docker stop -t 60 "$container" >/dev/null 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  log "Container $container verwijderd."
done

# 3. Eigen netwerk van het project (het tunnelnetwerk is van de testomgeving en blijft staan)
if docker network inspect "${PROJECT}_default" >/dev/null 2>&1; then
  docker network rm "${PROJECT}_default" >/dev/null 2>&1 && log "Netwerk ${PROJECT}_default verwijderd." || log "Waarschuwing: netwerk ${PROJECT}_default kon niet worden verwijderd."
fi

# 4. Lokaal gebouwde stagingimages (label), nooit images van de testomgeving
for image in $(docker image ls --filter "label=nl.aquatech.staging=1" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true); do
  [[ "$image" == aquatech-staging:* ]] || continue
  docker image rm "$image" >/dev/null 2>&1 && log "Image $image verwijderd." || true
done

# 5. De map: alleen als het echt de stagingmap is
if [[ -e "$STAGING_DIR" || -L "$STAGING_DIR" ]]; then
  [[ ! -L "$STAGING_DIR" ]] || { echo "FOUT: $STAGING_DIR is een symlink; niet verwijderd." >&2; exit 1; }
  [[ "$(basename "$STAGING_DIR")" == "aquatech-staging" ]] || { echo "FOUT: $STAGING_DIR is niet de stagingmap; niet verwijderd." >&2; exit 1; }
  [[ -e "$STAGING_DIR/install-staging.sh" || -e "$STAGING_DIR/.env" || -d "$STAGING_DIR/repo" ]] || { echo "FOUT: $STAGING_DIR lijkt geen stagingmap; niet verwijderd." >&2; exit 1; }
  rm -rf -- "$STAGING_DIR"
  log "Map $STAGING_DIR verwijderd."
fi
log "Staging is verwijderd. De testomgeving is niet aangeraakt."
