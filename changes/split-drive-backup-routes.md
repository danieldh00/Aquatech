---
titel: Drive-back-uproutes naar eigen bestand
---

## Nieuws

## Changelog
Intern: de routes van Beheer > Back-ups > Google Drive (`/api/admin/backups/drive*`) staan nu in `platform/drive-backup-routes.js` in plaats van in `server.js`. Alle Drive-routes krijgen nu een ruime limiet per gebruiker (120 verzoeken per 15 minuten), zoals de codecontrole eist; verder geen gedragswijziging.
