---
titel: Servertaak: schijf van apps01 vergroten
---

## Nieuws

## Changelog
Servertaak 013 (`013-schijf-apps01-vergroten`, `deploy/apps01/grow-disk.sh`): laat de VM na het vergroten van de virtuele schijf in Proxmox de nieuwe grootte inlezen en vergroot partitie (growpart), bij LVM ook de physical volume en logical volume, en het bestandssysteem (ext4, xfs, btrfs). Idempotent, zonder herstart. De bewakingscontrole *Vrije schijfruimte* leest de grootte bij elke ronde live uit (`statfs`), zonder cache; de nieuwe grootte zichtbaar maken in de app volgt als daar behoefte aan is.
