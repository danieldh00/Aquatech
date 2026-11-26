---
titel: Klanten archiveren en verwijderen vanuit het overzicht
---

## Nieuws
- [klanten] In het klantenoverzicht vink je klanten aan en kies je Archiveren of Terughalen. Met het filter *Actieve klanten / Gearchiveerd / Alles* bekijk je het archief.
- [beheer] Beheerders kunnen aangevinkte klanten ook definitief verwijderen (met wachtwoord). Klanten met offertes, werkorders, facturen of bestellingen blijven bewaard en worden met een reden overgeslagen; archiveren is dan het alternatief.

## Changelog
- `POST /api/customers/bulk` {action archiveren|terughalen|verwijderen, ids ≤ 100} (recht `klanten`; verwijderen alleen recht `beheer` + wachtwoord/tweestapscode via `createIdentityConfirm`, audit `klanten_gearchiveerd|teruggehaald|verwijderd`, 60 per kwartier). Een klant met actieve inlog wordt bij archiveren en verwijderen overgeslagen.
- `archive.removeSelected` (gerichte definitieve verwijdering per id, met dezelfde `ARCHIVABLE`- en koppelingscontrole als het archief); `selectionOf` kent state `alle`.
- Klantlijst en klantkaart geven `archivedAt`; frontend: vinkjes, actiebalk en archieffilter in `klanten/`.
