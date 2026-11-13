#!/usr/bin/env bash
# Database van Aquatech naar een eigen PostgreSQL naast de app: bediening VANAF DE PROXMOX-HOST (pve).
#
#   bash db-local.sh migrate            Supabase -> eigen PostgreSQL (app ca. 2-10 min uit)
#   bash db-local.sh rollback           terug naar Supabase, met de nieuwe gegevens
#   bash db-local.sh rollback --no-copy terug naar Supabase zonder de nieuwe gegevens mee te nemen
#   bash db-local.sh status             waar draait de database, back-ups
#   bash db-local.sh backup             nu een versleutelde back-up maken
#   bash db-local.sh restore <bestand>  een back-up terugzetten (naam uit `status`)
#
# Zonder download, rechtstreeks van GitHub:
#   curl -fsSL https://raw.githubusercontent.com/danieldh00/Aquatech/master/deploy/apps01/pve/db-local.sh -o /tmp/db-local.sh
#   bash /tmp/db-local.sh migrate
#
# Het script zoekt het gast-systeem `apps01` op de host (LXC via `pct exec`, VM via ssh), kopieert de bestanden uit
# deploy/apps01 (van GitHub, of uit SRC_DIR als je een checkout hebt) erheen en voert localdb/local-db.sh daar uit.
# Er gaan geen wachtwoorden over deze verbinding: de Supabase-URL staat al op de server in secrets/database-url
# en de nieuwe wachtwoorden worden daar aangemaakt.
#
# Instellingen (omgevingsvariabelen, allemaal optioneel):
#   APPS01_NAME   naam van het gast-systeem in Proxmox (standaard apps01)
#   APPS01_CTID   vaste LXC-id (anders gezocht met `pct list`)
#   APPS01_VMID   vaste VM-id (anders gezocht met `qm list`); verbinding via ssh
#   APPS01_SSH    ssh-doel, bijvoorbeeld root@192.168.1.20 (standaard root@<naam>, anders het IP via de guest agent)
#   APP_DIR       map op de server (standaard /opt/apps/aquatech)
#   REF           branch of tag op GitHub (standaard master)
#   SRC_DIR       map deploy/apps01 van een lokale checkout (in plaats van GitHub)
#   POSTGRES_TAG  hoofdversie van PostgreSQL (standaard 17)
#   SKIP_HASH=1   alleen aantallen controleren, niet de inhoud (bij een zeer grote database)
#   YES=1         geen bevestigingsvraag
set -euo pipefail

NAME="${APPS01_NAME:-apps01}"
APP_DIR="${APP_DIR:-/opt/apps/aquatech}"
REF="${REF:-master}"
RAW="https://raw.githubusercontent.com/danieldh00/Aquatech/$REF"
REMOTE_DIR="$APP_DIR/.localdb"

log() { echo "[$(date '+%F %T')] $*"; }
die() { echo "FOUT: $*" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || die "Draai dit als root op de Proxmox-host."

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
ACTION="${1:-}"; shift || true
case "$ACTION" in migrate | rollback | status | backup | restore) ;; *) usage ;; esac

# ---------- Gast-systeem zoeken: LXC (pct exec) of VM (ssh) ----------
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

# Een VM bereiken we via ssh: root@<naam>, of anders het IP-adres uit de QEMU guest agent.
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
# Voert een opdracht uit op de server; argumenten worden veilig doorgegeven. Stdin gaat mee (voor tar).
guest() {
  if [[ "$MODE" == "pct" ]]; then
    pct exec "$GUEST_ID" -- "$@"
  else
    local command_line
    printf -v command_line '%q ' "$@"
    ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$command_line"
  fi
}
if [[ "$MODE" == "pct" ]]; then log "Server: LXC $GUEST_ID ($NAME), via pct exec"; else log "Server: $SSH_TARGET, via ssh"; fi
guest true || die "Geen verbinding met de server. Controleer ssh (sleutel/wachtwoord) of zet APPS01_SSH / APPS01_CTID."

# ---------- Bestanden verzamelen en naar de server brengen ----------
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
fetch() { # <pad in deploy/apps01 of hub/…> <doelnaam>
  local from="$1" to="$2"
  if [[ -n "${SRC_DIR:-}" ]]; then
    local local_path="$SRC_DIR/$from"
    [[ "$from" == hub/* ]] && local_path="$SRC_DIR/../../$from"
    cp "$local_path" "$STAGE/$to" || die "Niet gevonden in SRC_DIR: $local_path"
  else
    local prefix="deploy/apps01/"
    [[ "$from" == hub/* ]] && prefix=""
    curl -fsSL "$RAW/$prefix$from" -o "$STAGE/$to" || die "Downloaden mislukt: $RAW/$prefix$from (staat de branch/tag $REF op GitHub?)"
  fi
}
fetch localdb/local-db.sh local-db.sh
fetch localdb/pg-backup.sh pg-backup.sh
fetch compose.localdb.yml compose.localdb.yml
fetch systemd/aquatech-pg-backup.service aquatech-pg-backup.service
fetch systemd/aquatech-pg-backup.timer aquatech-pg-backup.timer
fetch hub/backend/src/database/certs/supabase-root-2021.crt supabase-root-2021.crt
for script in local-db.sh pg-backup.sh; do bash -n "$STAGE/$script" || die "Syntaxfout in $script"; done

log "Bestanden naar de server kopiëren ($REMOTE_DIR)"
tar czf - -C "$STAGE" . | guest bash -c "umask 077 && rm -rf '$REMOTE_DIR' && mkdir -p '$REMOTE_DIR' && tar xzf - -C '$REMOTE_DIR'"

# ---------- Bevestiging ----------
confirm() { # <tekst>
  [[ "${YES:-}" == "1" ]] && return 0
  echo
  echo -e "$1"
  read -r -p "Typ 'ja' om door te gaan: " answer </dev/tty
  [[ "$answer" == "ja" ]] || die "Afgebroken; niets veranderd."
}
case "$ACTION" in
  migrate)
    confirm "Aquatech gaat van Supabase naar een eigen PostgreSQL-container op de server.\n  - De app en de webshop zijn ca. 2-10 minuten niet beschikbaar (schrijven geweigerd, daarna uit).\n  - Er wordt NIETS aan Supabase gewijzigd (alleen gelezen); bij een fout draait de app daarna weer op Supabase.\n  - Je krijgt een controle per tabel (aantallen en inhoud) en een versleutelde back-up." ;;
  rollback)
    if [[ "${1:-}" == "--no-copy" ]]; then
      confirm "Terug naar Supabase ZONDER de gegevens van na de overstap mee te nemen.\n  Alles wat sinds de overstap is gewijzigd (orders, offertes, ...) staat dan alleen nog in de eigen database."
    else
      confirm "Terug naar Supabase. De gegevens van de eigen database worden naar Supabase gekopieerd en vervangen daar schema 'aquatech'.\n  De app is daarbij ca. 2-10 minuten niet beschikbaar."
    fi ;;
  restore)
    [[ -n "${1:-}" ]] || die "Gebruik: db-local.sh restore <bestand>  (namen: db-local.sh status)"
    confirm "Back-up '$1' wordt teruggezet: de huidige gegevens worden vervangen (er wordt eerst een back-up van de huidige stand gemaakt).\n  De app is ca. 2-10 minuten niet beschikbaar." ;;
esac

# ---------- Uitvoeren (los van deze ssh-verbinding, zodat een verbroken verbinding de migratie niet midden in afbreekt) ----------
RUN=(bash "$REMOTE_DIR/local-db.sh" "$ACTION" "$@" --yes)
ENVIRONMENT=(APP_DIR="$APP_DIR" POSTGRES_TAG="${POSTGRES_TAG:-17}" SKIP_HASH="${SKIP_HASH:-0}" SUPABASE_SSLMODE="${SUPABASE_SSLMODE:-verify-full}")
log "Uitvoeren: local-db.sh $ACTION"
set +e
if guest bash -c 'command -v systemd-run' >/dev/null 2>&1 && [[ "$ACTION" =~ ^(migrate|rollback|restore)$ ]]; then
  guest systemd-run --quiet --wait --pipe --collect --unit "aquatech-localdb-$ACTION-$$" "${ENVIRONMENT[@]/#/--setenv=}" "${RUN[@]}"
else
  guest env "${ENVIRONMENT[@]}" "${RUN[@]}"
fi
CODE=$?
set -e
if (( CODE != 0 )); then die "local-db.sh $ACTION eindigde met code $CODE (zie de meldingen hierboven)."; fi
log "Klaar."
