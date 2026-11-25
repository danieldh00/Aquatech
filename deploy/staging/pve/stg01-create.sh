#!/usr/bin/env bash
# Maakt de staging-VM stg01 aan op de Proxmox-host (als root). Wordt door servertaak 012 (servertaken.sh) uitgevoerd en is
# veilig opnieuw te draaien: bestaat de VM al, dan gebeurt er niets. Doet:
#   1. haalt het Debian 12 cloud-image op en controleert het tegen SHA512SUMS van Debian;
#   2. maakt de VM (2 vCPU, 3 GB RAM, 32 GB schijf, vmbr0, start bij het opstarten van de host);
#   3. zet via cloud-init de gebruiker `daniel` (sudo zonder wachtwoord) met de publieke sleutel van root op deze host en
#      installeert de guest agent, zodat de host het IP-adres van de VM kan opvragen;
#   4. start de VM. Docker en de rest installeert setup-staging.sh daarna zelf.
#   VMID (standaard 9101), STORAGE (standaard local-lvm), SNIPPETS_STORAGE (standaard local), BRIDGE (standaard vmbr0)
set -euo pipefail

VMID="${VMID:-9101}"
STORAGE="${STORAGE:-local-lvm}"
SNIPPETS_STORAGE="${SNIPPETS_STORAGE:-local}"
BRIDGE="${BRIDGE:-vmbr0}"
NAME="stg01"
IMG_DIR="https://cloud.debian.org/images/cloud/bookworm/latest"
IMG_FILE="debian-12-genericcloud-amd64.qcow2"

die() { echo "FOUT: $*" >&2; exit 1; }
[[ $(id -u) -eq 0 ]] || die "Dit script draait als root op de Proxmox-host."
command -v qm >/dev/null || die "qm ontbreekt: dit script draait op de Proxmox-host."

if qm list | awk 'NR>1 {print $2}' | grep -qx "$NAME"; then
  echo "VM $NAME bestaat al; niets te doen."
  exit 0
fi
! qm status "$VMID" >/dev/null 2>&1 || die "VM-id $VMID is al in gebruik door een andere VM; draai opnieuw met VMID=<vrij nummer>."

# Sleutel van root op de host, zodat de host straks met ssh bij stg01 kan (geen wachtwoorden). Ontbreekt hij, dan maken we er een.
pubkey="/root/.ssh/id_ed25519.pub"
if [[ ! -f "$pubkey" ]]; then
  pubkey="$(ls /root/.ssh/id_*.pub 2>/dev/null | head -n1 || true)"
  if [[ -z "$pubkey" ]]; then
    install -d -m 700 /root/.ssh
    ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519
    pubkey="/root/.ssh/id_ed25519.pub"
  fi
fi

# Cloud-init-snippets moeten op de opslag aan staan (Datacenter > Storage > Content > Snippets); dat doen we hier zelf.
content="$(pvesm config "$SNIPPETS_STORAGE" 2>/dev/null | sed -n 's/^content: *//p' | head -n1)"
if ! grep -qw snippets <<<"$content"; then
  pvesm set "$SNIPPETS_STORAGE" --content "${content:+$content,}snippets" >/dev/null || die "Snippets aanzetten op opslag $SNIPPETS_STORAGE is mislukt."
fi
snippet_dir="$(pvesm path "$SNIPPETS_STORAGE:snippets/stg01-user.yaml" | xargs dirname)"
install -d -m 755 "$snippet_dir"

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
curl -fsSL -m 900 "$IMG_DIR/$IMG_FILE" -o "$work/$IMG_FILE"
curl -fsSL -m 60 "$IMG_DIR/SHA512SUMS" -o "$work/SHA512SUMS"
expected="$(awk -v f="$IMG_FILE" '$2 == f {print $1}' "$work/SHA512SUMS")"
[[ -n "$expected" ]] || die "SHA512SUMS bevat $IMG_FILE niet."
actual="$(sha512sum "$work/$IMG_FILE" | awk '{print $1}')"
[[ "$expected" == "$actual" ]] || die "Controlesom van het Debian-image klopt niet; niets aangemaakt."

cat > "$snippet_dir/stg01-user.yaml" <<YAML
#cloud-config
hostname: stg01
users:
  - name: daniel
    groups: [sudo]
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
    ssh_authorized_keys:
      - $(cat "$pubkey")
ssh_pwauth: false
package_update: true
packages: [qemu-guest-agent, curl, openssl, ca-certificates, gnupg]
runcmd:
  - systemctl enable --now qemu-guest-agent
YAML

qm create "$VMID" --name "$NAME" --memory 3072 --balloon 0 --cores 2 --cpu host --ostype l26 --agent enabled=1 \
  --net0 "virtio,bridge=$BRIDGE" --scsihw virtio-scsi-pci --serial0 socket --vga serial0 --onboot 1
qm importdisk "$VMID" "$work/$IMG_FILE" "$STORAGE" >/dev/null
disk="$(qm config "$VMID" | sed -n 's/^unused0: *//p' | head -n1)"
[[ -n "$disk" ]] || die "Geïmporteerde schijf niet gevonden."
qm set "$VMID" --scsi0 "$disk" --boot order=scsi0 --ide2 "$STORAGE:cloudinit" --ipconfig0 ip=dhcp \
  --cicustom "user=$SNIPPETS_STORAGE:snippets/stg01-user.yaml" >/dev/null
qm resize "$VMID" scsi0 32G >/dev/null
qm start "$VMID"
echo "VM $NAME ($VMID) gestart."
