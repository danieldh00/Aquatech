#!/usr/bin/env bash
# Eenmalig op apps01: updaten vanuit de app inrichten (Beheer > Systeem > Updates).
#
# Vanaf de Proxmox-host (pve):
#   ssh -t root@apps01 'curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01/setup-app-update.sh -o /tmp/aquatech-app-update.sh && bash /tmp/aquatech-app-update.sh'
#
# Doet:
#   1. haalt update.sh, compose.yml en de systemd-units uit master (oude bestanden blijven als *.bak-<datum>);
#   2. maakt update/status (root, voor de app alleen-lezen) en update/request (uid 1000, mode 700);
#   3. installeert aquatech-update.path (start de update meteen na "Nu updaten"); service en timer alleen als ze
#      er nog niet zijn;
#   4. maakt de container opnieuw met de twee mappen en wacht tot hij healthy is (anders terug naar de oude compose.yml);
#   5. draait update.sh één keer, zodat Beheer meteen de beschikbare versie toont.
# Veilig om opnieuw te draaien.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
RAW="https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01"
STAMP="$(date +%Y%m%d%H%M)"

[[ $(id -u) -eq 0 ]] || exec sudo -E bash "$0" "$@"
cd "$APP_DIR"
log() { echo "[$(date '+%F %T')] $*"; }
die() { echo "FOUT: $*" >&2; exit 1; }

wait_healthy() {
  local st=""
  for _ in $(seq 1 40); do
    st="$(docker inspect -f '{{.State.Health.Status}}' aquatech 2>/dev/null || true)"
    [[ "$st" == "healthy" ]] && return 0
    sleep 3
  done
  return 1
}

# ---------- 1. Bestanden ----------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for file in update.sh compose.yml systemd/aquatech-update.path systemd/aquatech-update.service systemd/aquatech-update.timer; do
  curl -fsSL "$RAW/$file" -o "$tmp/$(basename "$file")" || die "Kon $file niet ophalen."
done
grep -q 'UPDATE_REQUEST_DIR' "$tmp/compose.yml" || die "De compose.yml uit master kent updaten vanuit de app nog niet."

for file in update.sh compose.yml; do
  if [[ -f "$file" ]] && ! cmp -s "$file" "$tmp/$file"; then
    cp -a "$file" "$file.bak-$STAMP"
    log "$file bijgewerkt (oude versie: $file.bak-$STAMP). Verschil:"
    diff -u "$file.bak-$STAMP" "$tmp/$file" || true
  fi
  install -m 755 "$tmp/$file" "$file"
done
chmod 644 compose.yml

# ---------- 2. Mappen ----------
mkdir -p update/status update/request
chown root:root update update/status
chmod 755 update update/status
chown 1000:1000 update/request
chmod 700 update/request
log "Mappen update/status (root) en update/request (uid 1000) staan klaar"

# ---------- 3. systemd ----------
install -m 644 "$tmp/aquatech-update.path" /etc/systemd/system/aquatech-update.path
for unit in aquatech-update.service aquatech-update.timer; do
  [[ -f "/etc/systemd/system/$unit" ]] || { install -m 644 "$tmp/$unit" "/etc/systemd/system/$unit"; log "$unit geïnstalleerd"; }
done
systemctl daemon-reload
systemctl enable --now aquatech-update.timer >/dev/null
systemctl enable --now aquatech-update.path >/dev/null
log "aquatech-update.path staat aan"

# ---------- 4. Container opnieuw met de mappen ----------
docker compose up -d aquatech
if ! wait_healthy; then
  log "Container niet healthy; terug naar de vorige compose.yml"
  [[ -f "compose.yml.bak-$STAMP" ]] && cp -a "compose.yml.bak-$STAMP" compose.yml
  docker compose up -d aquatech
  die "Inrichten mislukt; de app draait weer zoals eerst. Zie: docker compose logs --tail 60 aquatech"
fi
log "Container draait met de updatemappen"

# ---------- 5. Eerste controle ----------
systemctl start aquatech-update.service || log "Let op: update.sh gaf een fout, zie journalctl -u aquatech-update.service -n 40"
log "Klaar. In Beheer > Systeem > Updates zie je nu de draaiende en de beschikbare versie."
