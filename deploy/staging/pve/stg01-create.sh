#!/usr/bin/env bash
# Eenmalig op de Proxmox-host (pve, als root): maakt de staging-VM stg01 aan (2 vCPU, 3 GB, 32 GB schijf) uit het
# Debian 12 cloud-image, met docker via cloud-init. Doet niets als de VM al bestaat. De VM krijgt alleen het interne
# vmbr0-netwerk (zelfde als apps01); wie de VM bereikt, ziet staging alleen via de tunnel.
#
#   VMID    vaste VM-id (standaard 9101)       STORAGE  opslag voor de schijf (standaard local-lvm)
#   SSHKEY  bestand met de publieke sleutel die op stg01 mag inloggen (standaard /root/.ssh/id_ed25519.pub)
set -euo pipefail

VMID="${VMID:-9101}"
STORAGE="${STORAGE:-local-lvm}"
SSHKEY="${SSHKEY:-/root/.ssh/id_ed25519.pub}"
NAME="stg01"
IMG_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"

[[ $(id -u) -eq 0 ]] || { echo "FOUT: als root op de Proxmox-host draaien." >&2; exit 1; }
command -v qm >/dev/null || { echo "FOUT: dit script draait op de Proxmox-host (qm ontbreekt)." >&2; exit 1; }
if qm list | awk '{print $2}' | grep -qx "$NAME"; then echo "VM $NAME bestaat al; niets te doen."; exit 0; fi
! qm status "$VMID" >/dev/null 2>&1 || { echo "FOUT: VM-id $VMID is al in gebruik; geef VMID=<vrij nummer> mee." >&2; exit 1; }
[[ -f "$SSHKEY" ]] || { echo "FOUT: sleutelbestand $SSHKEY ontbreekt." >&2; exit 1; }

dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT
curl -fsSL -m 600 "$IMG_URL" -o "$dir/debian.qcow2"
cat > /var/lib/vz/snippets/stg01-user.yaml 2>/dev/null <<'YAML' || { echo "FOUT: snippets-map ontbreekt (Datacenter > Storage > local > Content > Snippets aanzetten)." >&2; exit 1; }
#cloud-config
hostname: stg01
users:
  - name: daniel
    sudo: ALL=(ALL) NOPASSWD:ALL
    shell: /bin/bash
package_update: true
packages: [docker.io, docker-compose-v2, curl, openssl, qemu-guest-agent]
runcmd:
  - systemctl enable --now docker qemu-guest-agent
YAML
qm create "$VMID" --name "$NAME" --memory 3072 --cores 2 --cpu host --ostype l26 --agent 1 \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci --serial0 socket --vga serial0 --onboot 1
qm importdisk "$VMID" "$dir/debian.qcow2" "$STORAGE" >/dev/null
qm set "$VMID" --scsi0 "$STORAGE:vm-$VMID-disk-0" --boot order=scsi0 --ide2 "$STORAGE:cloudinit" \
  --ipconfig0 ip=dhcp --sshkeys "$SSHKEY" --cicustom "user=local:snippets/stg01-user.yaml"
qm resize "$VMID" scsi0 32G
qm start "$VMID"
echo "VM $NAME ($VMID) gestart; cloud-init installeert docker (enkele minuten)."
