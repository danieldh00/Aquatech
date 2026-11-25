#!/usr/bin/env bash
# Vergroot de root-partitie en het bestandssysteem van apps01 nadat de virtuele schijf in Proxmox groter is gemaakt.
# Detecteert zelf de indeling (gewone partitie of LVM) en het bestandssysteem (ext2/3/4, xfs, btrfs). Veilig herhaalbaar:
# is alles al volledig vergroot, dan verandert er niets. Draait als root op apps01 (servertaak 013, via servertaken.sh).
# Alleen voor de test te wijzigen: SYS_BLOCK (standaard /sys/class/block).
set -euo pipefail

SYS_BLOCK="${SYS_BLOCK:-/sys/class/block}"

log() { echo "[schijf] $*"; }
fail() { echo "FOUT: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fail "dit script moet als root draaien."

# Laat de kernel de nieuwe grootte van de virtuele schijven opnieuw inlezen (nodig zonder herstart van de VM).
rescan_disks() {
  local file
  for file in "$SYS_BLOCK"/*/device/rescan; do
    [[ -e "$file" ]] || continue
    echo 1 > "$file" 2>/dev/null || true
  done
}

# Zorgt dat growpart beschikbaar is (pakket cloud-guest-utils).
need_growpart() {
  command -v growpart >/dev/null 2>&1 && return 0
  log "growpart ontbreekt: cloud-guest-utils installeren."
  DEBIAN_FRONTEND=noninteractive apt-get install -y cloud-guest-utils >/dev/null || fail "installeren van cloud-guest-utils mislukt (geen internet of apt-fout)."
}

# Geeft "<schijf> <partitienummer>" voor een partitieapparaat, of faalt als het geen partitie is.
split_partition() { # <apparaat>
  local part name disk number
  part="$(readlink -f "$1")"
  name="${part##*/}"
  [[ -r "$SYS_BLOCK/$name/partition" ]] || return 1
  number="$(<"$SYS_BLOCK/$name/partition")"
  disk="$(lsblk -no PKNAME "$part" | head -n1 | tr -d ' ')"
  [[ -n "$disk" && -n "$number" ]] || return 1
  echo "/dev/$disk $number"
}

# Vergroot een partitie tot het eind van de schijf (geen wijziging = prima).
grow_partition() { # <partitieapparaat>
  local pair disk number output
  pair="$(split_partition "$1")" || fail "$1 is geen partitie waarvan ik de schijf kan bepalen."
  disk="${pair% *}"; number="${pair#* }"
  need_growpart
  if output="$(growpart "$disk" "$number" 2>&1)"; then
    log "partitie $number van $disk vergroot."
  elif grep -q '^NOCHANGE' <<<"$output"; then
    log "partitie $number van $disk is al zo groot als kan."
  else
    fail "growpart $disk $number mislukte: $output (een partitie die niet achteraan de schijf staat kan niet groeien)."
  fi
}

# Vergroot het bestandssysteem op / tot het hele apparaat.
grow_filesystem() { # <apparaat> <bestandssysteem>
  case "$2" in
    ext2|ext3|ext4) resize2fs "$1" ;;
    xfs) xfs_growfs / ;;
    btrfs) btrfs filesystem resize max / ;;
    *) fail "bestandssysteem $2 wordt niet ondersteund; vergroot / met de hand." ;;
  esac
}

source_device="$(findmnt -no SOURCE /)"
filesystem="$(findmnt -no FSTYPE /)"
[[ -n "$source_device" && -n "$filesystem" ]] || fail "kan het apparaat van / niet bepalen."
log "Voor: $(df -h / | tail -n1)"
rescan_disks

device_type="$(lsblk -no TYPE "$source_device" | head -n1 | tr -d ' ')"
if [[ "$device_type" == "lvm" ]]; then
  volume_group="$(lvs --noheadings -o vg_name "$source_device" | tr -d ' ')"
  [[ -n "$volume_group" ]] || fail "volumegroep van $source_device niet gevonden."
  log "LVM: volumegroep $volume_group."
  for physical_volume in $(pvs --noheadings -o pv_name -S "vg_name=$volume_group" | tr -d ' '); do
    if split_partition "$physical_volume" >/dev/null; then grow_partition "$physical_volume"; fi
    pvresize "$physical_volume"
  done
  free_bytes="$(vgs --noheadings --nosuffix --units b -o vg_free "$volume_group" | tr -d ' ')"
  if [[ "${free_bytes:-0}" -ge 4194304 ]]; then
    lvextend -l +100%FREE "$source_device"
  else
    log "geen vrije ruimte in de volumegroep om de logische volume te vergroten."
  fi
else
  grow_partition "$source_device"
fi
grow_filesystem "$source_device" "$filesystem"
log "Na: $(df -h / | tail -n1)"
