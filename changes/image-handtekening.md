---
titel: Image-handtekening controleren bij een update
---

## Changelog
Audit B-03 (vervolg): de Dockerfile en `deploy/apps01/compose.yml` zetten het basisimage `node:22-alpine` en `cloudflared` op digest vast (cloudflared op versie 2026.9.3 in plaats van `latest`). `update.sh` controleert na het ophalen de cosign-handtekening van het image (identiteit: `release.yml` op `master` van deze repo) voordat de onderhoudsmodus aan gaat; een ongeldige of ontbrekende handtekening stopt de update en slaat die versie over. De controle werkt zodra cosign op de server staat (nieuwe servertaak `011-image-handtekening-controleren`, die ook `update.sh` vernieuwt); `IMAGE_SIGNATURE` in `.env` kent `auto` (standaard), `required` en `off`. Het ondertekenen zelf zit in `release.yml` (aparte PR).
