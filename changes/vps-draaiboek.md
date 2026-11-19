---
titel: Draaiboek voor de verhuizing naar een VPS
---

## Nieuws
- [beheer] Beheer > Systeem heeft een afvinkbaar draaiboek voor de verhuizing naar een VPS: voorbereiden, inrichten, proefverhuizing, verhuisdag, controle en terugvallen.

## Changelog
Nieuwe sectie *Draaiboek VPS-verhuizing* (`beheer/index.html` formulier `s-vps`, `beheer/vps-draaiboek.js`, sectie `vps` in
`beheer/indeling.js`, alleen zichtbaar voor wie Systeem > Updates mag zien): vaste tekst met zes fasen (tunnel, adres en
hoofdsleutel blijven gelijk; database via back-up; proefrun met `local-db.sh restore`; oude server 14 dagen als terugval;
mailconnector-IP, Drive, Visma en Mollie controleren; image alleen `amd64`). De vinkjes staan per browser in localStorage.
Geen migratie, geen backend. `deploy/apps01/README.md` verwijst ernaar.
